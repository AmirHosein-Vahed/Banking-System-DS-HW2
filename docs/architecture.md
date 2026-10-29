# Architecture

## 1. Goals and constraints

* Two independent shards, each with its own PostgreSQL database and two
  application replicas.
* Accounts are partitioned by account id; each account has exactly one
  authoritative shard.
* The client only knows the gateway; shards and replicas are invisible to it.
* Local operations must be ACID; same-shard transfers are a single database
  transaction; cross-shard transfers use 2PC and never leave one side applied.
* The coordinator must survive a crash and rebuild unresolved transactions from
  durable state.
* Everything runs with `docker compose` on one host.

Explicit non-goals: database replication/failover (not required by the
assignment), multi-host deployment, and the two expert bonuses.

## 2. Components

| Component | Process | State | Responsibility |
| --- | --- | --- | --- |
| Gateway | `dist/apps/gateway/main.js` | none (health cache) | Public API, validation, shard lookup, replica selection, local vs cross-shard dispatch, concurrency limit. |
| Shard replica | `dist/apps/shard/main.js` | none | Account operations and the participant side of 2PC for one shard. Two identical replicas per shard. |
| Coordinator | `dist/apps/coordinator/main.js` | coordinator DB | Creates transactions, runs prepare/decide/phase two, recovery sweep, status API. |
| Bootstrap | `dist/apps/bootstrap/main.js` | – | Runs migrations once and seeds accounts. Exits. |
| Databases | `postgres:17-alpine` | WAL | `shard-a-db`, `shard-b-db` (accounts, ledgers, participant journal) and `coordinator-db` (transaction journal). |
| Client | `dist/apps/cli/main.js` | none | `bankctl`, a thin HTTP client for the gateway. |

All application processes run from **one image** (`ds-banking`); the Compose
`command` selects the role. This guarantees that shard, gateway, coordinator and
CLI always share the same code and configuration model.

### Compose topology

```
edge network      gateway ───── client
                     │
coord network     coordinator ── coordinator-db
                     │
shard-a network   shard-a-1 ─┐
                  shard-a-2 ─┴─ shard-a-db
shard-b network   shard-b-1 ─┐
                  shard-b-2 ─┴─ shard-b-db
```

The gateway and the coordinator are attached to the shard networks because both
call shard replicas directly. Shard replicas are **not** attached to the edge
network; only the gateway publishes a host port (`8080`).

## 3. Shard map

[`config/shard-map.yaml`](../config/shard-map.yaml):

```yaml
version: 1
shards:
  A:
    ranges: [{ from: A0001, to: A1000 }]
    replicas:
      - { id: a1, url: "http://shard-a-1:8080" }
      - { id: a2, url: "http://shard-a-2:8080" }
  B:
    ranges: [{ from: A1001, to: A2000 }]
    replicas:
      - { id: b1, url: "http://shard-b-1:8080" }
      - { id: b2, url: "http://shard-b-2:8080" }
```

At startup each process parses the file with `zod` and validates the map:

* account ids match `A[0-9]{4}`, ranges are non-empty and ordered;
* ranges are contiguous and cover exactly `A0001–A2000` (no gaps, overlaps or
  accounts outside the map);
* replica ids are unique across the whole map and replica URLs are valid.

`ShardMap.resolve()` is a binary search over the sorted ranges. A shard asserts
ownership of every account it touches (`assertOwns`), so a misrouted request is
rejected with `409 WRONG_SHARD` instead of modifying the wrong database. The map
version and a canonical fingerprint are logged by every service and exposed by
`GET /v1/status`.

## 4. Request flows

### 4.1 Balance / deposit / withdraw

```
client -> gateway: GET /v1/accounts/A0500/balance
gateway: validate -> resolve(A0500) = shard A -> pick healthy replica (RR)
gateway -> shard-a-1: GET /internal/v1/accounts/A0500/balance (internal token)
shard-a-1 -> shard-a-db: SELECT balance FROM accounts WHERE account_id = 'A0500'
shard-a-1 -> gateway: { accountId, balance }
gateway -> client: 200 + x-shard-id: A + x-replica-id: a1
```

Writes additionally pass the idempotency key and payload hash to the shard,
which records the result in `client_requests` in the same transaction.

### 4.2 Same-shard transfer

The gateway sees that both accounts resolve to the same shard and calls
`POST /internal/v1/local-transfers` on one replica of that shard. The shard runs
one transaction: lock both rows in account-id order, check the balance, update
both rows, append two ledger entries, store the idempotency record, commit. The
coordinator is not involved.

### 4.3 Cross-shard transfer

```
client -> gateway: POST /v1/transfers {from A0500, to A1500}
gateway -> coordinator: POST /internal/v1/transfers (same idempotency key)
coordinator: insert transaction + participants (durable)
coordinator -> shard B replica: PREPARE credit A1500
coordinator -> shard A replica: PREPARE debit A0500
coordinator: record votes; decide; durable COMMIT_DECIDED
coordinator -> shard A: COMMIT    coordinator -> shard B: COMMIT
coordinator: mark acks; COMPLETED
gateway -> client: 200 {txId, outcome: COMMITTED}
```

Participants are prepared in the order `[destination shard, source shard]`. This
makes the common rejection case (source cannot pay) observable: the destination
is already `PREPARED` (with a held row lock) when the source votes NO, so
scenario A really exercises "abort prepared participants" rather than aborting
before anything was prepared.

The gateway returns success only after every participant acknowledged the
commit. If the coordinator is still finishing, the gateway returns `202` with a
status URL.

## 5. Data model

### Shard database (identical schema on A and B)

```sql
accounts(account_id PK, balance bigint >= 0, version, updated_at)
ledger_entries(id, tx_id, account_id, delta, reason, created_at)
client_requests(request_id PK, payload_hash, response jsonb, created_at)
participant_txs(tx_id PK, gid UNIQUE, shard_id, ops jsonb, state, updated_at)
```

* `accounts.balance` is the authoritative balance; `version` increments on every
  change and is useful in logs and for debugging.
* `ledger_entries` is an append-only audit trail: every deposit, withdrawal and
  transfer leg writes one row. `sum(balance)` per shard plus the ledger can be
  reconciled at any time.
* `client_requests` stores the response of an idempotent client request keyed by
  `request_id`, together with a hash of the payload.
* `participant_txs` is the participant's own durable journal for 2PC, including
  `PREPARING`, `PREPARED`, `COMMITTED`, `ABORTED` and abort tombstones.

### Coordinator database

```sql
transactions(tx_id PK, client_request_id UNIQUE, from_account, to_account,
             amount, status, outcome, version, timestamps)
participants(tx_id, shard_id, gid, vote, vote_reason, ack, attempts, last_error,
             PK (tx_id, shard_id))
tx_events(id, tx_id, from_status, to_status, detail, created_at)
```

`transactions` is the authoritative decision log. `participants` stores each
participant's vote and acknowledgement. `tx_events` is an append-only transition
history used for the report and for debugging; it is not needed to recover.

## 6. Concurrency control

### Gateway

`attachConcurrencyLimit` counts in-flight requests and rejects requests above
`MAX_CONCURRENT_REQUESTS` with `503 OVERLOADED` and `Retry-After: 1`. Rejected
requests are not counted, so the counter cannot drift.

### Shard writes

All writes use PostgreSQL transactions:

* deposits/withdrawals: single-row update with `RETURNING balance`;
* withdrawals: `UPDATE … WHERE account_id = $1 AND balance >= $2` so a negative
  balance is impossible even when two withdrawals race;
* local transfers: `SELECT … ORDER BY account_id FOR UPDATE` on both rows, which
  gives a deterministic lock order and prevents A→B / B→A deadlocks;
* every write bumps `version` and appends a ledger row.

Two replicas of the same shard are just two clients of the same database, so
these guarantees are independent of which replica received the request (this is
what experiment 3 demonstrates).

### Idempotency

Client request ids are serialised with `pg_advisory_xact_lock(hashtextextended($1, 0))`
inside the write transaction, then looked up in `client_requests`. A retry with
the same payload returns the stored response without re-applying anything; a
different payload returns `409 IDEMPOTENCY_CONFLICT`.

The coordinator uses the same idea on `transactions.client_request_id` (unique
constraint + advisory lock in `create`), so a retried cross-shard transfer maps
to the same transaction and the same outcome.

### Participant 2PC

* A session-level advisory lock on the transaction id serialises `PREPARE`,
  `COMMIT` and `ABORT` for one transaction on one database. It is released
  automatically if the session dies.
* `PREPARE` sets `lock_timeout = 2s`; a prepare that cannot get its row locks
  fails fast with a NO vote instead of pinning a connection forever.
* A semaphore limits concurrent prepares to `DB_POOL_SIZE - 3`, reserving
  connections for `COMMIT PREPARED` / `ROLLBACK PREPARED`. Without it, a burst of
  prepares that wait on row locks can occupy the whole pool, so no connection is
  left to resolve the prepared transactions that hold those locks.
* The abort tombstone (`ABORTED` row for an unknown transaction) fences a late
  prepare: the prepare's `upsertPreparing` only rewrites rows still in
  `PREPARING`, and the advisory lock prevents the two from interleaving.

### Coordinator

* `KeyedMutex` serialises `drive()` per transaction id, so a client request and
  the recovery sweep can never both prepare/decide/acknowledge the same
  transaction. This is what removed duplicated `tx.ack` / `tx.completed` events.
* Transfers are additionally serialised per account (both accounts, sorted), so
  prepared transactions do not pile up on the same hot account. Transfers
  between disjoint accounts still run concurrently.
* Journal updates lock the `transactions` row with `SELECT … FOR UPDATE` and
  check the current status inside the same transaction, so a stale writer cannot
  overwrite a newer decision.

The durable journal remains authoritative: the mutexes only prevent redundant
work inside one process. After a restart the in-memory maps are empty and the
state machine is rebuilt from the rows.

## 7. Health checking and failover

The gateway probes `GET /healthz` on every configured replica every
`HEALTH_INTERVAL_MS` (2 s) with a 500 ms timeout. A replica becomes unhealthy
after `HEALTH_FAILURE_THRESHOLD` (3) consecutive failures and healthy again on the
first success. `replicasInOrder(shardId)` returns only healthy replicas of the
requested shard, rotated round-robin.

If a call to a replica fails at the transport level, the shard client tries the
next healthy replica of the same shard. Deterministic application errors (4xx)
are never retried. If no healthy replica remains, the gateway returns
`503 SHARD_UNAVAILABLE`; it never falls back to a different shard.

The coordinator calls participants through `HttpParticipantClient`, which also
iterates over the replicas of a shard on transport errors. Because prepared
transactions live in the shared database, a retry on another replica is safe.

## 8. Durability and recovery

* PostgreSQL WAL + `synchronous_commit=on` makes every acknowledged
  `COMMIT`/`COMMIT PREPARED` durable.
* `max_prepared_transactions=200` allows native prepared transactions.
* Coordinator state transitions and participant votes/acks are durable rows,
  written before the corresponding RPCs. The decision record (`COMMIT_DECIDED` /
  `ABORT_DECIDED`) is written before any participant is told to commit/abort.
* On startup the coordinator runs a recovery sweep before reporting readiness
  (`/readyz` stays `503` until the sweep is done), then repeats the sweep every
  `RESOLVER_INTERVAL_MS`.
* A transaction that cannot finish phase two stays `PENDING`; the resolver
  retries and `GET /v1/transactions/{txId}` keeps answering.

## 9. Observability

* Every process uses `pino` and logs one JSON object per line, with `service`,
  `shard` and `replica` in the base fields.
* The gateway assigns or propagates `x-request-id`; it is returned to the client
  and forwarded to shards and the coordinator, so one request can be followed
  across processes.
* Structured events: `request`, `response`, `tx.begin`, `tx.phase`, `tx.vote`,
  `tx.decision`, `tx.ack`, `tx.ack_failed`, `tx.completed`, `tx.pending`,
  `recovery.sweep`, `replica.healthy`, `replica.unhealthy`, `shard.retry`.
* Responses include `x-shard-id` and `x-replica-id`, which is what the
  experiments use to visualise routing.

Example:

```json
{"level":30,"service":"shard","shard":"A","replica":"a2","event":"response",
 "requestId":"0f86…","method":"GET","url":"/internal/v1/accounts/A0500/balance",
 "action":"balance","account":"A0500","statusCode":200,"latencyMs":2}
```

## 10. Security

Internal endpoints require `x-internal-token`. The edge network publishes only
the gateway port. There is no TLS, no per-customer authentication and no rate
limiting; those are out of scope for the assignment and are called out as
limitations.

## 11. Why these choices

* **Native PostgreSQL prepared transactions** instead of a custom "prepare"
  table: the database enforces the prepared state, holds row locks and survives
  a process crash, which is exactly the guarantee 2PC needs. The participant
  journal adds the bookkeeping PostgreSQL does not provide (idempotent votes,
  abort tombstones, a state API).
* **Stateless replicas on a shared database** instead of primary/replica
  databases: the assignment requires replicas but explicitly does not require
  database replication. Shared storage makes replica failover trivial and keeps
  ACID guarantees.
* **A separate coordinator database** (not one of the shards): the coordinator's
  decision must survive the failure of any shard, and scenario C must not depend
  on a shard being available.
* **Separate coordinator process/container**: scenarios B and C require killing
  and restarting only the coordinator. A logically separate module inside the
  gateway would make that demo artificial.
