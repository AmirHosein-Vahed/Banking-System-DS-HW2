# Distributed Banking Platform

A sharded, replicated banking backend with a shard-aware gateway and cross-shard
transfers coordinated by Two-Phase Commit (2PC).

Built for *Distributed Systems — Assignment 2*: two independent PostgreSQL
shards, two stateless application replicas per shard, a gateway that routes by
account ownership, and a coordinator whose decisions survive a crash.

```
                      +---------------------------+
   bankctl / curl --->|  Gateway  :8080           |
                      |  shard map + health + RR  |
                      +------+-------------+------+
                             |             |
              local ops      |             |  cross-shard transfer
                             v             v
             +----------------------+   +---------------------------+
             | Shard A              |   | Coordinator :8081        |
             |  replica a1 / a2     |   |  durable tx journal      |
             |----------------------|   |  prepare / decide / ack  |
             |  PostgreSQL A        |   +------+-------------+------+
             +----------------------+          |             |
                                               v             v
             +----------------------+   (2PC RPCs to the shard replicas)
             | Shard B              |
             |  replica b1 / b2     |
             |----------------------|
             |  PostgreSQL B        |
             +----------------------+
```

* **Shard A** owns `A0001–A1000`, **Shard B** owns `A1001–A2000`.
* Replicas are stateless processes; the shard database is the single source of
  truth, so any replica of a shard can serve any request for that shard.
* The gateway never sends an account's request to another shard. When a shard
  has no healthy replica the request fails with `503 SHARD_UNAVAILABLE` instead
  of being "balanced" somewhere else.

## Contents

- [Quick start](#quick-start)
- [Public API](#public-api)
- [CLI](#cli)
- [How it works](#how-it-works)
- [Correctness and failure handling](#correctness-and-failure-handling)
- [Configuration](#configuration)
- [Tests](#tests)
- [Experiments](#experiments)
- [Project layout](#project-layout)
- [Limitations](#limitations)
- [Documentation](#documentation)

## Quick start

Requirements: Docker with Compose v2, Node.js 24 (only for tests, the load
generator and the CLI outside Docker).

```bash
cp .env.example .env
make up                 # build the image and start 3 databases + 4 replicas + coordinator + gateway
make ps                 # every service should be healthy
```

`bootstrap` runs once: it applies the SQL migrations and seeds all 2,000
accounts with `SEED_BALANCE` (default `1000`).

```bash
make cli ARGS="balance A0500"
make cli ARGS="deposit A0500 100"
make cli ARGS="withdraw A0500 40"
make cli ARGS="transfer A0100 A0200 250"          # same shard: one local transaction
make cli ARGS="transfer A0500 A1500 300 --wait"   # cross shard: 2PC
make cli ARGS="status <txId>"
```

Or with plain HTTP:

```bash
curl -s localhost:8080/v1/accounts/A0500/balance
curl -s -X POST localhost:8080/v1/accounts/A0500/deposits \
  -H 'content-type: application/json' -H 'idempotency-key: demo-1' \
  -d '{"amount":100}'
curl -s -X POST localhost:8080/v1/transfers \
  -H 'content-type: application/json' -H 'idempotency-key: demo-2' \
  -d '{"from":"A0500","to":"A1500","amount":300}'
```

`make down` stops everything, `make reset` also removes the volumes (a fresh
seed on the next start).

## Public API

All responses are JSON and carry the request id that also appears in the logs.

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| `GET` | `/v1/accounts/{account}/balance` | – | Routed to the owning shard. |
| `POST` | `/v1/accounts/{account}/deposits` | `{"amount": 100}` | `Idempotency-Key` header (or `requestId` in the body). |
| `POST` | `/v1/accounts/{account}/withdrawals` | `{"amount": 40}` | `409 INSUFFICIENT_FUNDS` when the balance is too low. |
| `POST` | `/v1/transfers` | `{"from":"A0500","to":"A1500","amount":300}` | Same-shard: atomic local transaction. Cross-shard: 2PC. |
| `GET` | `/v1/transactions/{txId}` | – | `PENDING` until every participant acknowledged the decision, then `COMPLETED` + `outcome`. |
| `GET` | `/v1/status` | – | Shard map version/fingerprint and replica health. |
| `GET` | `/healthz`, `/readyz` | – | Liveness and readiness (used by Compose). |

Responses for balance/write calls include `x-shard-id` and `x-replica-id`, which
makes routing observable from the outside.

Cross-shard transfers return `200` once **all** participants acknowledged the
commit. If the decision is durable but phase two has not finished, the gateway
returns `202` with a `statusUrl`; the transaction is then `PENDING` and can be
queried by id. An aborted transfer returns the underlying cause, for example
`409 INSUFFICIENT_FUNDS` with `details.txId`; the aborted transaction remains
queryable and stays `ABORTED` forever.

### Error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Malformed account id, amount, or body. |
| `ACCOUNT_NOT_FOUND` | 404 | Account is outside the configured shard map / not seeded. |
| `INSUFFICIENT_FUNDS` | 409 | Withdrawal or debit would make a balance negative. |
| `IDEMPOTENCY_CONFLICT` | 409 | The idempotency key was reused with a different payload. |
| `TX_NOT_FOUND` | 404 | Unknown transaction id. |
| `TX_CONFLICT` | 409 | A participant refused to reverse a committed decision. |
| `OVERLOADED` | 503 | Configured concurrency limit reached (`Retry-After: 1`). |
| `SHARD_UNAVAILABLE` | 503 | No healthy replica for the owning shard. |
| `COORDINATOR_UNAVAILABLE` | 503 | Coordinator unreachable during a cross-shard transfer. |
| `UNAUTHORIZED` | 401 | Missing/invalid internal token on an internal endpoint. |
| `INTERNAL_ERROR` | 500/502/504 | Unexpected failure or upstream timeout. |

Clients should treat `5xx` and ambiguous timeouts as *unknown* and retry with
the **same** `Idempotency-Key`: the shard and coordinator journals make retries
safe and return the original outcome.

## CLI

`bankctl` (in the `client` Compose profile or via `npm run cli -- …`) talks only
to the gateway:

```bash
bankctl balance A0500
bankctl deposit A0500 100
bankctl withdraw A0500 40
bankctl transfer A0100 A0200 250
bankctl transfer A0500 A1500 300 --wait    # polls /v1/transactions until COMPLETED
bankctl status <txId>
bankctl --json …                            # raw response
bankctl --request-id <id> …                 # explicit idempotency key
```

Exit code `0` on success, `1` on a rejected operation, `2` when `--wait` times
out.

## How it works

### Sharding and routing

The shard map lives in [`config/shard-map.yaml`](config/shard-map.yaml): a
version, contiguous account ranges and the replicas of each shard. It is loaded
and validated by every process at startup (contiguity, full coverage of
`A0001–A2000`, unique replica ids, URLs). A fingerprint of the map is logged and
exposed by `/v1/status` so that all components can be checked for agreement.

Routing is a binary search over the ranges in
[`shard-map.ts`](src/modules/routing/domain/shard-map.ts). A request is then
sent to one of the **healthy replicas of that shard**, chosen round-robin. The
replica set is refreshed by active `GET /healthz` probes every 2 s; a replica is
removed after 3 consecutive failures and added back on the first success.

### Local operations and same-shard transfers

Deposits, withdrawals and same-shard transfers run in a single PostgreSQL
transaction (see [`pg-account-store.ts`](src/modules/accounts/adapters/pg-account-store.ts)):

* `SELECT … FOR UPDATE` on both accounts **ordered by account id**, so opposite
  transfers cannot deadlock;
* the debit uses a conditional update (`balance >= amount`), so a concurrent
  withdrawal can never drive a balance negative;
* every mutation appends a row to `ledger_entries`;
* the client request is recorded in `client_requests` together with a hash of
  its payload, inside the same transaction.

Because the replicas share the database, row locks and transactions provide the
same guarantees no matter which replica handled the HTTP request. The `version`
column is incremented on every balance change for observability.

### Cross-shard transfers (2PC)

The coordinator keeps a durable journal in its own database
(`transactions`, `participants`, `tx_events`) and drives the classic state
machine:

```
INITIATED -> PREPARING -> PREPARED -> COMMIT_DECIDED -> COMPLETED
                     \-> ABORT_DECIDED ---------------> COMPLETED
```

Participants use **native PostgreSQL prepared transactions** plus a durable
`participant_txs` journal in the shard database:

1. `PREPARE` takes a session advisory lock on the transaction id, writes the
   journal row (`PREPARING`), then inside one database transaction applies the
   debit/credit, appends ledger rows and runs `PREPARE TRANSACTION '<gid>'`.
   The row locks are now held by a *prepared* transaction.
2. `COMMIT` / `ABORT` are idempotent: `COMMIT PREPARED` is executed only if the
   gid still exists, the journal state is updated, and repeated calls are safe.
   An `ABORT` that arrives before the prepare writes an `ABORTED` tombstone so a
   late prepare can never commit after the abort decision.

The full protocol, the state tables and the recovery argument are in
[`docs/2pc-protocol.md`](docs/2pc-protocol.md). A durable `COMMIT_DECIDED`
record is written **before** any participant is told to commit, and recovery
only ever replays the recorded decision.

### Concurrency

| Layer | Mechanism |
| --- | --- |
| Gateway | Configurable maximum of simultaneous requests; excess requests get `503 OVERLOADED` with `Retry-After`. |
| Gateway → shard | Round-robin over the healthy replicas of the owning shard. |
| Shard writes | Row locks in deterministic order, conditional updates, `version` bump, ledger append. |
| Idempotency | `pg_advisory_xact_lock` on the request id + `client_requests` payload hash. |
| Participant 2PC | Session advisory lock per transaction id, `lock_timeout` on prepare, semaphore that reserves database connections for phase two. |
| Coordinator | Serialisation per transaction id *and* per account pair (in sorted order), journal rows locked with `SELECT … FOR UPDATE`. |

The per-account serialisation in the coordinator deserves a note: a prepared
transaction keeps the row locks of the accounts it touched until phase two
finishes. Two concurrent transfers that share an account would otherwise block
each other inside PostgreSQL, and under load those blocked prepares can occupy
every connection of a shard pool. Serialising transfers that share an account
(in the same sorted order as the database locks) keeps transactions short;
transfers between disjoint accounts still run in parallel.

### Durability

* PostgreSQL runs with `synchronous_commit=on` and WAL; a `COMMIT`/`COMMIT
  PREPARED` acknowledged to the client is on disk.
* `max_prepared_transactions=200` on every shard database.
* Coordinator decisions, participant votes and acknowledgements are rows in
  PostgreSQL, written in transactions; the in-memory mutexes are only an
  optimisation and are rebuilt from the journal after a restart.
* On startup the coordinator sweeps every unresolved transaction and continues
  from its durable phase before reporting readiness. The resolver repeats that
  sweep every 5 s.

## Correctness and failure handling

| Scenario | What happens |
| --- | --- |
| One shard rejects a transfer (insufficient funds) | The other participant may already be `PREPARED`; the coordinator records `ABORT_DECIDED` and sends `ABORT` to every participant. No money moves. |
| All prepared, coordinator dies | Every shard holds a prepared transaction; the coordinator stays `PREPARED`. After restart the resolver sees all `YES` votes, writes `COMMIT_DECIDED` and commits both participants exactly once. |
| `COMMIT_DECIDED` durable, coordinator dies | On restart the resolver only reads the recorded decision and completes phase two. It never replaces a commit with an abort. |
| A participant is temporarily down | Phase two retries with backoff (resolver sweep) until the participant acknowledges; the transaction stays `PENDING` and is queryable. |
| Duplicate `COMMIT`/`ABORT` | Both are idempotent; the participant journal and `pg_prepared_xacts` decide what is left to do. |
| Client retries a request | Same idempotency key returns the stored result; a different payload with the same key is rejected with `409 IDEMPOTENCY_CONFLICT`. |
| Replica dies | Health probes remove it after ≤ 3 failures (~6 s); the gateway uses the other replica of the same shard. No other shard is ever used. |
| Both replicas of a shard die | `503 SHARD_UNAVAILABLE`; money is never guessed from another shard. |

## Configuration

Compose reads `.env` (see `.env.example`). The most useful variables:

| Variable | Default | Used by | Meaning |
| --- | --- | --- | --- |
| `INTERNAL_TOKEN` | `dev-internal-token` | all | Shared secret for internal endpoints. |
| `LOG_LEVEL` | `info` | all | Pino level. |
| `SEED_BALANCE` | `1000` | bootstrap | Initial balance of every account. |
| `GATEWAY_MAX_CONCURRENCY` | `200` | gateway | Max simultaneous public requests. |
| `SHARD_MAX_CONCURRENCY` | `100` | shards | Max simultaneous requests per replica. |
| `HEALTH_INTERVAL_MS` | `2000` | gateway | Health probe period. |
| `HEALTH_FAILURE_THRESHOLD` | `3` | gateway | Failures before a replica is removed. |
| `PREPARE_TIMEOUT_MS` | `5000` | coordinator | Timeout of one participant RPC. |
| `RESOLVER_INTERVAL_MS` | `5000` | coordinator | Recovery sweep period. |
| `DB_POOL_SIZE` | `10` | shard/coordinator | PostgreSQL pool size. |
| `FAULTS` | *(empty)* | coordinator | `crash_after_prepare` or `crash_after_decision`; **demo only**. |

Per-service variables (`PORT`, `SHARD_ID`, `REPLICA_ID`, `DATABASE_URL`,
`SHARD_MAP_PATH`, …) are documented in `.env.example` and the Compose file.

## Tests

```bash
npm test               # 38 unit tests, no Docker required
npm run test:integration   # 10 end-to-end tests against a running stack
npm run typecheck
npm run lint
```

Unit tests cover money/account validation, shard-map validation and boundaries,
the transaction state machine, the keyed mutex/semaphore, replica health and
round-robin selection, and the coordinator's 2PC flows against an in-memory
journal (commit, NO vote, unreachable participant, idempotent replay, concurrent
drivers).

Integration tests exercise the real stack through the gateway: routing, 404s,
idempotent deposits, insufficient funds, local and cross-shard transfers,
abort propagation, and 40 concurrent opposite transfers with exact balances.

## Experiments

Each script is self-contained, prints a `PASS`/`FAIL` line per claim, writes
logs and JSON evidence to `artifacts/<timestamp>-<name>/`, and exits non-zero on
failure.

```bash
make exp1   # shard distribution and routing
make exp2   # replica load distribution (round robin)
make exp3   # concurrent clients: 400 reads per shard + exact deposits/withdrawals
make exp4   # replica interruption and failover
make exp5   # local vs cross-shard transfer, abort case, conservation
make exp6   # coordinator crash after prepare / after durable commit + recovery
make exp7   # concurrent opposite cross-shard transfers
```

Run them sequentially; several of them temporarily stop or crash a container.
[`docs/experiments.md`](docs/experiments.md) lists the exact claims and sample
output.

## Project layout

```
src/
  apps/
    gateway/            public HTTP API and routing
    shard/              account + participant HTTP API for one shard
    coordinator/        2PC API, recovery loop
    bootstrap/          migrations and seed
    cli/                bankctl
  modules/
    accounts/           account domain, ports, PostgreSQL store, HTTP routes
    participation/      participant side of 2PC (journal, prepared xacts)
    coordination/       coordinator state machine, journal, client, faults
    routing/            shard map, health registry, shard client
  shared/
    domain/             errors, money, ids, hashing
    infra/              logger, env, HTTP helpers, clients, mutex, semaphore
config/shard-map.yaml
migrations/{shard,coordinator}/
deploy/compose.yaml
scripts/experiments/
test/{unit,integration}/
docs/
```

Dependencies point inwards: domain → application → adapters. PostgreSQL and
HTTP details stay in adapters; the state machine, validation and shard map are
pure TypeScript and unit-testable without a database.

## Limitations

* One coordinator process: it is the only writer of the coordinator journal and
  a single point of failure while it is down. Recovery is automatic on restart
  (`make up` / `docker compose … up -d coordinator`), but there is no hot
  standby. Multiple coordinators would need leader election on top of the same
  durable journal.
* The per-account coordinator mutex assumes a single coordinator instance; with
  several, the database row locks would still be correct but slower.
* Database replication and failover are explicitly out of scope; each shard has
  one database.
* Round-robin is used for replica selection (the assignment allows any
  documented policy); it does not account for in-flight request counts.
* The internal network is trusted (`INTERNAL_TOKEN`, plain HTTP). TLS,
  authentication of bank clients and rate limiting per customer are out of
  scope.
* `FAULTS` is a demo hook and must stay empty outside experiments. Since it exits
  the process, Compose keeps the container stopped until it is started again.

## Documentation

* [`docs/architecture.md`](docs/architecture.md) — components, data model,
  request flows, concurrency and durability.
* [`docs/2pc-protocol.md`](docs/2pc-protocol.md) — protocol, journal schemas,
  recovery, scenario walkthroughs.
* [`docs/experiments.md`](docs/experiments.md) — how to run each experiment and
  what it demonstrates.
* [`docs/requirements.md`](docs/requirements.md) — requirement → implementation
  traceability, including the Assignment 1 guarantees that still apply.
