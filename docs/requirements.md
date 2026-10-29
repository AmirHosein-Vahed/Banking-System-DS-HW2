# Requirement Traceability

This document maps every requirement of *Assignment 2* (and the Assignment 1
requirements it carries over) to the implementation, tests or experiments that
satisfy it. File references point at the code; experiment references point at
scripts under [`scripts/experiments/`](../scripts/experiments).

## Assignment 2 — main project

### 1. Goal and components

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Accounts partitioned across 2 independent shards | `config/shard-map.yaml`, 2 PostgreSQL containers, `ShardMap` | exp 1 |
| Each shard has multiple application replicas | `shard-a-1`, `shard-a-2`, `shard-b-1`, `shard-b-2` in `deploy/compose.yaml` | exp 1, 2 |
| Cross-shard transfers coordinated with 2PC | `CoordinatorService`, `ParticipantService`, PostgreSQL prepared transactions | exp 5, 6, 7 |
| Everything runs with Docker Compose | `deploy/compose.yaml`, `Dockerfile`, `Makefile` | `make up`, `make ps` |
| Client talks only to the gateway | `src/apps/cli/main.ts`, public routes in `src/apps/gateway/routes.ts` | CLI demo |
| Gateway selects shard by ownership, then replica among healthy ones | `ShardMap.resolve`, `HealthRegistry.replicasInOrder`, `ShardClient` | exp 1, 2, 4 |
| Replica selection policy documented | Round robin over healthy replicas — README, `docs/architecture.md` | exp 2 |
| Gateway invokes the coordinator for cross-shard transfers | `src/apps/gateway/routes.ts` (`/v1/transfers`) | exp 5 |
| Replicas hold no authoritative balance | stateless processes over one shared DB per shard | exp 2, 3, 4 |
| Coordinator assigns a unique transaction id, runs prepare/commit, records decisions, recovers | `coordinator-service.ts`, `pg-tx-journal.ts`, recovery loop in `apps/coordinator/main.ts` | exp 6 |
| Shard map stored in a config file | `config/shard-map.yaml`, validated by `ShardMap.load` | exp 1 |
| Shard A = A0001–A1000, Shard B = A1001–A2000 | shard map, seed job | exp 1 |

### 2. Sharding and routing

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Deterministic partitioning, exactly one owner per account | contiguous validated ranges, binary search | exp 1 |
| Full dataset not copied to every shard | each DB contains only its own range; seed loops per shard | exp 1, SQL check |
| Requests go to the owning shard, never an unrelated one | `assertOwns`, `SHARD_UNAVAILABLE` instead of cross-shard fallback | exp 1, 4 |
| Spread an account's requests over that shard's replicas | `HealthRegistry.replicasInOrder` + `ShardClient` retry | exp 2, 4 |
| Concurrent operations on one shard do not lose updates | PostgreSQL transactions, row locks, conditional updates, shared DB | exp 3, integration test |
| Gateway detects unavailable replicas and routes to a healthy one of the *same* shard | active health probes, failure threshold, replica retry | exp 4 |
| Database replication/failover not required | documented as out of scope | – |

### 3. Banking operations

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Balance, deposit, withdraw, transfer | public routes + `PgAccountStore` | exp 1, 3, 5 |
| Local operations are ACID and durable | one PostgreSQL transaction per write, ledger append, `synchronous_commit=on` | exp 3, 4, integration |
| Same-shard transfer is one atomic local transaction | `transferLocal` locks both rows in order and updates both | exp 5 |
| Cross-shard transfer never leaves one side applied | 2PC with prepared transactions | exp 5, 6, 7 |
| Example A0500→A1500 300 yields 700/800 | same behaviour; balances are seeded at 1000 | exp 5 (different amount, same mechanism) |

### 4. Distributed transactions (2PC)

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Prepare: validate, durably prepare without committing, vote | `ParticipantService.prepare` + `PREPARE TRANSACTION` | exp 5, 6 |
| Commit only if all vote YES, otherwise abort | `PgTxJournal.decide`, `CoordinatorService.prepareAll` | exp 5 |
| Decision recorded durably before being sent | `decide()` commits the row before phase two | exp 6 C |
| Participants handle repeated COMMIT/ABORT safely | idempotent `commit`/`abort`, gid existence check, journal states | unit tests, exp 6 |
| Not two unrelated sequential updates | single distributed transaction with a durable journal | exp 5, 6 |
| Persistent statuses INITIATED…COMPLETED | `transactions.status` + `ALLOWED_TRANSITIONS` | unit tests, exp 6 |
| Unique transaction id | UUID from `newId()` | exp 5 |
| Coordinator rebuilds unresolved transactions after restart | startup sweep + resolver | exp 6 |
| No success before all participants confirm COMMIT | gateway returns 200 only when `COMPLETED`; otherwise 202 | exp 5, 6 |
| Queryable PENDING/UNKNOWN status by transaction id | `GET /v1/transactions/{txId}` returns `PENDING`/`COMPLETED`; unknown → `404 TX_NOT_FOUND` | exp 5, 6 |

### 5. Recovery scenarios

| Scenario | Implementation | Evidence |
| --- | --- | --- |
| A — one YES, one rejects, abort all prepared | `ABORT_DECIDED` + `ABORT` to every participant | exp 5 |
| B — all prepared, coordinator stops, recover | `PREPARED` → resolver writes `COMMIT_DECIDED` and finishes | exp 6 B |
| C — commit recorded, not all acknowledged, finish commit | `COMMIT_DECIDED` is never recomputed or replaced | exp 6 C |

### 6. Required experiments

| # | Experiment | Script | Status |
| --- | --- | --- | --- |
| 1 | Shard distribution | `01-shard-distribution.sh` | passing |
| 2 | Replica load distribution | `02-replica-distribution.sh` | passing |
| 3 | Concurrent replica operations | `03-concurrent-clients.sh` | passing |
| 4 | Replica interruption | `04-replica-failover.sh` | passing |
| 5 | Local and cross-shard transfers | `05-transfers.sh` | passing |
| 6 | Interrupted distributed transaction | `06-coordinator-recovery.sh` | passing |
| 7 | Concurrent cross-shard transfers | `07-concurrent-transfers.sh` | passing |

### 7. Deliverables

| Deliverable | Status |
| --- | --- |
| Complete source code on GitHub | not published yet (repository is prepared; see `git init` / push) |
| Docker image on Docker Hub | not published yet (`docker build` produces `ds-banking:local`) |
| Technical report (≤ 10 pages) | material in `README.md`, `docs/architecture.md`, `docs/2pc-protocol.md`, `docs/experiments.md` |
| Demo video (≤ 15 min) | experiment scripts are the runbook; see the suggested order below |

Suggested video order: `make up` → exp 1 → exp 2 → exp 3 → exp 5 → exp 7 →
exp 4 → exp 6 (crash + recovery) → `make ps`.

## Assignment 1 — carried-over requirements

### 2.1 Concurrency and shared state

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Serve multiple clients concurrently | Fastify, async handlers, PostgreSQL pool | exp 3, 7 |
| Maximum simultaneous clients is configurable, not hard-coded | `GATEWAY_MAX_CONCURRENCY`, `SHARD_MAX_CONCURRENCY`; `attachConcurrencyLimit`; rejected with `503 OVERLOADED` + `Retry-After` | configuration table in README |
| Account data is shared state for every handler | one database per shard shared by its replicas | exp 2, 3, 4 |
| Simultaneous operations on one account stay correct | row locks, conditional debit, serialised idempotent requests | exp 3 (120 writes, exact balance), exp 7 |
| Never negative balances or lost updates | `CHECK (balance >= 0)`, `WHERE balance >= amount`, transaction per write | exp 3, integration test |

Concrete "many concurrent withdrawals on the same account" case: exp 3 runs 60
deposits and 60 withdrawals of 3 concurrently against the same account and
asserts the balance returns exactly to its starting value; the integration test
does the same through the gateway.

### 2.2 Transactions and ACID

| Property | How it is guaranteed | Evidence |
| --- | --- | --- |
| Atomicity | one PostgreSQL transaction per operation; transfers update both rows or neither; prepared transactions for cross-shard | exp 5 abort case (balances unchanged) |
| Consistency | `CHECK` constraints (positive amounts, non-negative balances), validation before any write, ledger append in the same transaction | unit tests, exp 3, 5 |
| Isolation | row-level locks, `SELECT … FOR UPDATE` in deterministic order, serialisable outcomes; prepared transactions hold locks until phase two | exp 3, 7 |
| Durability | PostgreSQL WAL + `synchronous_commit=on`; coordinator and participant journals are tables; success is only returned after commit | exp 4 (acknowledged deposit survives replica loss), exp 6 (decision survives coordinator crash) |

"Killed and restarted with previously confirmed transactions still there": the
database is the durable store, so killing a replica (exp 4) leaves every
acknowledged write visible through the surviving replica, and killing the
coordinator (exp 6) leaves every decision recoverable.

### 2.3 Error handling

| Required case | Behaviour | Code |
| --- | --- | --- |
| Unknown account | `404` | `ACCOUNT_NOT_FOUND` |
| Insufficient funds | `409`, no partial update | `INSUFFICIENT_FUNDS` |
| Negative/zero/invalid amount | `400` | `VALIDATION_ERROR` |
| Unsupported action/route | `404` | `UNSUPPORTED_OPERATION` |
| Missing fields | `400` (zod) | `VALIDATION_ERROR` |
| Malformed JSON / broken body | `400` | `VALIDATION_ERROR` |
| Shard with no healthy replica | `503`, never another shard | `SHARD_UNAVAILABLE` |
| Coordinator unavailable | `503` | `COORDINATOR_UNAVAILABLE` |
| Duplicate idempotency key with another payload | `409` | `IDEMPOTENCY_CONFLICT` |
| Overload | `503` + `Retry-After` | `OVERLOADED` |

The server keeps running after every error; the handler is centralised in
`src/shared/infra/http.ts` and unit/integration tests exercise the main cases.

### 2.4 Logging

Every request and response is logged by `attachRequestLogging` with:

| Field | Source |
| --- | --- |
| Request ID | `x-request-id` (generated if absent, returned to the client, forwarded internally) |
| Client IP | `request.ip` (+ `x-forwarded-for`) |
| Action | `request.action` (`balance`, `deposit`, `withdraw`, `transfer`, `2pc.*`) |
| Account ID | `request.account` |
| Timestamp | pino ISO timestamp |
| Result | `success`/`error` and the HTTP status |
| Latency | `latencyMs` measured by the hook |

Logs are JSON lines with `service`, `shard` and `replica`, so the replica that
served a request is identifiable both in logs and via the `x-replica-id`
response header (exp 2).

## Expert bonuses

Bonus I (live re-sharding) and Bonus II (self-healing) are **not implemented**
and are explicitly out of scope for this submission. No code or configuration in
this repository claims to support them.
