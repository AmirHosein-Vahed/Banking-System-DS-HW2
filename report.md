# Distributed Banking Platform — Technical Report

**Course:** Distributed Systems — Assignment 2  
**Date:** 2026-11-06  
**System Version:** 0.1.0  
**Repository:** `https://github.com/AmirHosein-Vahed/Banking-System-DS-HW2`  

---

## Executive Summary

This report documents the architectural design, technical solutions, correctness proofs, and experimental verification of a sharded, replicated distributed banking platform. The system supports high-throughput local banking operations and atomic cross-shard account transfers governed by Two-Phase Commit (2PC). 

The platform guarantees strict ACID properties across multiple PostgreSQL database instances without relying on ORMs or global databases. Replicas are completely stateless, and coordinator decisions persist in a durable transaction journal that survives abrupt process crashes and container restarts.

---

## 1. System Architecture and Process Topology

The platform comprises nine distinct processes orchestrated via Docker Compose:

```
                       +-----------------------------------+
    bankctl / HTTP --->|  Shard-Aware Gateway (:8080)      |
                       |  Health Probes + Round Robin      |
                       +---------+---------------+---------+
                                 |               |
              local operations   |               |  cross-shard transfers
                                 v               v
             +-----------------------+   +---------------------------+
             | Shard A               |   | Coordinator (:8081)       |
             |  replicas: a1, a2     |   |  durable tx journal       |
             |-----------------------|   |  prepare / decide / ack   |
             | PostgreSQL A          |   +------+-------------+------+
             +-----------------------+          |             |
                                                v             v
             +-----------------------+   (2PC RPCs to shard replicas)
             | Shard B               |
             |  replicas: b1, b2     |
             |-----------------------|
             | PostgreSQL B          |
             +-----------------------+
```

### 1.1 Service Components

1. **Shard-Aware Gateway (`:8080`):** Single point of entry for clients. Performs binary-search account routing, monitors replica health, balances load across healthy replicas using round-robin, and proxies cross-shard transfer requests to the coordinator.
2. **Shard Replicas (`shard-a-1`, `shard-a-2`, `shard-b-1`, `shard-b-2`):** Stateless Node.js Fastify services serving both public account operations (balance, deposit, withdraw, same-shard transfer) and internal 2PC participant endpoints (`/v1/internal/2pc/*`).
3. **Transaction Coordinator (`:8081`):** Manages the 2PC protocol state machine, persists execution journals, drives background resolution of unresolved transactions, and supports demo fault injection (`FAULTS`).
4. **Database Tier:** Three isolated PostgreSQL 17 instances:
   - `shard-a-db`: Accounts `A0001` through `A1000`.
   - `shard-b-db`: Accounts `A1001` through `A2000`.
   - `coordinator-db`: Global transaction journal, participant votes, and recovery event logs.
5. **Bootstrap Service:** Executes schema migrations with advisory locking and seeds 2,000 accounts with initial balances (`SEED_BALANCE=1000`).

---

## 2. Sharding, Routing, and Replica Health

### 2.1 Deterministic Shard Mapping
The partition configuration lives in `config/shard-map.yaml`. Account ownership is defined by contiguous range boundaries:
- **Shard A:** `A0001` – `A1000`
- **Shard B:** `A1001` – `A2000`

At startup, the `ShardMap` domain model parses and validates the YAML map for:
1. Complete, contiguous coverage from `A0001` to `A2000` without gaps or overlaps.
2. Uniqueness of all replica identifiers (`a1`, `a2`, `b1`, `b2`).
3. Valid account formatting (`^A[0-9]{4}$`).

A SHA-256 fingerprint of canonical shard map data is logged and returned in `GET /v1/status` to ensure cluster-wide configuration agreement.

### 2.2 Account Routing & Health Probing
Account resolution uses $O(\log N)$ binary search over sorted numeric ranges. The Gateway maintains an active `HealthRegistry` polling `/healthz` on each replica every `HEALTH_INTERVAL_MS` (default 2000ms):
- If a replica fails 3 consecutive health checks (`HEALTH_FAILURE_THRESHOLD`), it is marked `unhealthy` and evicted from active routing.
- Requests to a shard are distributed round-robin among its `healthy` replicas.
- If an entire shard has no healthy replicas, requests targeting that shard fail immediately with `503 SHARD_UNAVAILABLE`. Requests are **never** misrouted to an unrelated shard.

---

## 3. Concurrency Control and Local ACID Semantics

### 3.1 Single-Shard Local Operations
Deposits, withdrawals, and same-shard transfers run within a single PostgreSQL transaction (`pg-account-store.ts`):

```sql
BEGIN;
SELECT balance, version FROM accounts WHERE account_id = $1 FOR UPDATE;
UPDATE accounts SET balance = balance + $2, version = version + 1 WHERE account_id = $1;
INSERT INTO ledger_entries (tx_id, account_id, delta, reason) VALUES (...);
INSERT INTO client_requests (request_id, payload_hash, response) VALUES (...);
COMMIT;
```

### 3.2 Key Technical Protections

1. **Ordered Lock Acquisition:** When transferring money between accounts within the same shard, row locks (`SELECT ... FOR UPDATE`) are acquired strictly in sorted account ID order (e.g., `A0100` before `A0200`). This completely eliminates deadlocks under concurrent reverse transfers (`A0100 -> A0200` vs. `A0200 -> A0100`).
2. **Conditional Debit:** Withdrawals enforce an inline SQL condition (`WHERE balance >= amount`) alongside database `CHECK (balance >= 0)` constraints, making negative balances mathematically impossible.
3. **Idempotency via Advisory Locks:** Duplicate client requests presenting the same `Idempotency-Key` return stored responses from `client_requests`. If the same key is reused with a different payload, `409 IDEMPOTENCY_CONFLICT` is raised. Concurrency control during key insertion uses `pg_advisory_xact_lock(hashtext(key))`.
4. **Configurable Concurrency Limits:** Gateway and shard replicas apply `attachConcurrencyLimit`, enforcing maximum active request thresholds (`GATEWAY_MAX_CONCURRENCY=200`, `SHARD_MAX_CONCURRENCY=100`). Excess requests receive `503 OVERLOADED` with a `Retry-After: 1` header.

---

## 4. Distributed Two-Phase Commit (2PC) Protocol

Cross-shard transfers touch two independent databases and cannot use a single PostgreSQL transaction. They are managed by the coordinator via Two-Phase Commit combined with native PostgreSQL Prepared Transactions.

### 4.1 State Machine

```
         +-----------+
         | INITIATED |
         +-----+-----+
               |
               v
         +-----------+
         | PREPARING |
         +-----+-----+
               |
     +---------+---------+
     |                   |
     v (all YES)         v (any NO / Timeout)
+----+-----------+ +-----+--------+
| COMMIT_DECIDED | | ABORT_DECIDED|
+----+-----------+ +-----+--------+
     |                   |
     +---------+---------+
               |
               v
         +-----------+
         | COMPLETED |
         +-----------+
```

### 4.2 Durable Journal Schema

#### Coordinator Database (`coordinator-db`)
- `transactions`: Primary record holding `tx_id`, `client_request_id`, `from_account`, `to_account`, `amount`, `status`, `outcome`, and timestamps.
- `participants`: Status of each branch (`shard_id`, `gid`, `vote`, `ack`, `attempts`, `last_error`).
- `tx_events`: Audit trail logging state transitions and error details.

#### Shard Database (`shard-a-db`, `shard-b-db`)
- `participant_txs`: Local journal (`tx_id`, `gid`, `shard_id`, `ops`, `state`: `PREPARING` | `PREPARED` | `COMMITTED` | `ABORTED`).

### 4.3 Phase 1: Prepare Protocol
1. **Coordinator Init:** The coordinator generates a unique `tx_id` (UUID), writes an `INITIATED` record to `transactions`, and sets status to `PREPARING`.
2. **Participant Dispatch:** The coordinator issues `POST /v1/internal/2pc/prepare` RPCs to the replicas for `toShard` and `fromShard`.
3. **Participant Lock & Prepare:**
   - Obtains a session advisory lock (`pg_advisory_lock`) on the `tx_id`.
   - Opens a local PostgreSQL transaction:
     ```sql
     SET LOCAL lock_timeout = 2000;
     -- Apply debit or credit to accounts table
     -- Append ledger entry
     PREPARE TRANSACTION 'tx_id:shard_id';
     ```
   - Writes state `PREPARED` to `participant_txs`.
   - Returns vote `YES`.
4. **Abort Handling:** If account validation fails (e.g., insufficient funds), or if `lock_timeout` expires, the participant rolls back, writes state `ABORTED`, and votes `NO`.

### 4.4 Phase 2: Decision and Execution
1. **Decision Persist First:**
   - If all participants vote `YES`, the coordinator writes `status = 'COMMIT_DECIDED'`, `outcome = 'COMMITTED'` in a single database transaction.
   - If any participant votes `NO` or times out, the coordinator writes `status = 'ABORT_DECIDED'`, `outcome = 'ABORTED'`.
   - **Crucial Invariant:** The decision is durably committed to disk in `coordinator-db` **before** any participant is instructed to commit or abort.
2. **Phase Two Execution:**
   - Coordinator sends `POST /v1/internal/2pc/commit` or `/abort` RPCs to participants.
   - Participants execute `COMMIT PREPARED 'gid'` or `ROLLBACK PREPARED 'gid'` and update `participant_txs` state to `COMMITTED` or `ABORTED`.
   - Once all participants reply with acknowledgment (`ack = 'DONE'`), the coordinator transitions transaction status to `COMPLETED`.

---

## 5. Recovery Scenarios and Correctness Proofs

### 5.1 Scenario A: One Participant Rejects
- **Situation:** Shard A votes `YES` (prepares debit), but Shard B votes `NO` due to `INSUFFICIENT_FUNDS` or validation failure.
- **Handling:** Coordinator enters `ABORT_DECIDED`. It sends `ABORT` RPCs to Shard A. Shard A executes `ROLLBACK PREPARED`, releasing row locks and restoring balance. No money moves.

### 5.2 Scenario B: Coordinator Crash After All Prepared
- **Situation:** Both participants vote `YES` and enter `PREPARED`. Coordinator crashes (`FAULTS=crash_after_prepare`) before writing a decision.
- **Recovery:**
  1. Upon restart, the coordinator's background resolver scans for unresolved transactions where `status = 'PREPARING'`.
  2. It inspects participant votes: seeing both voted `YES`, it advances the transaction to `COMMIT_DECIDED` and executes Phase 2.
  3. Accounts are debited/credited exactly once.

### 5.3 Scenario C: Coordinator Crash After Durable Decision
- **Situation:** Coordinator writes `COMMIT_DECIDED` to disk, but crashes (`FAULTS=crash_after_decision`) before receiving acknowledgments from participants.
- **Recovery:**
  1. Upon restart, the resolver finds `status = 'COMMIT_DECIDED'`.
  2. Because the decision was already persisted, the resolver **never** re-evaluates votes or converts the outcome to `ABORT`.
  3. It re-issues `COMMIT` RPCs to participants until all confirm `ack = 'DONE'`, then marks the transaction `COMPLETED`.

---

## 6. Experimental Verification

The platform was subjected to seven automated experiment suites located in `scripts/experiments/`. All tests run against the live Docker Compose deployment.

| Exp # | Experiment Name | Key Claim Tested | Result | Artifact Directory |
|:---:|:---|:---|:---:|:---|
| **01** | Shard Distribution | Routing matches range boundaries (`A0001–A1000` -> Shard A; `A1001–A2000` -> Shard B). | **PASS** | `artifacts/...-01-shard-distribution` |
| **02** | Replica Load Distribution | Gateway balances reads across `a1`/`a2` and `b1`/`b2` round-robin. | **PASS** | `artifacts/...-02-replica-distribution` |
| **03** | Concurrent Replica Ops | 120 concurrent deposits/withdrawals across replicas yield exact net balance. | **PASS** | `artifacts/...-03-concurrent-clients` |
| **04** | Replica Failover | Stopping `shard-a-2` routes 100% traffic to `shard-a-1` without request loss. | **PASS** | `artifacts/...-04-replica-failover` |
| **05** | Transfers & Conservation | Local vs. cross-shard transfers maintain total money supply across shards. | **PASS** | `artifacts/...-05-transfers` |
| **06** | Interrupted 2PC Recovery | Coordinator recovers cleanly from crashes post-prepare (B) and post-decision (C). | **PASS** | `artifacts/...-06-coordinator-recovery` |
| **07** | Concurrent Transfers | 40 concurrent bidirectional cross-shard transfers complete with exact money conservation. | **PASS** | `artifacts/...-07-concurrent-transfers` |

---

## 7. Limitations and Future Work

1. **Single Coordinator Instance:** The coordinator is a single process. While its state is fully durable in PostgreSQL and recovers automatically upon restart, cross-shard transfers are unavailable while the coordinator container is down.
2. **Prepared Transaction Lock Duration:** PostgreSQL prepared transactions hold row locks until Phase 2 completes. Prolonged network partitions between coordinator and shards can cause lock contention on touched accounts.
3. **Round-Robin Policy:** Replica routing uses static round-robin and active health probes without inspecting real-time CPU/memory utilization or in-flight HTTP request counts.

---

## 8. Conclusion

The distributed banking platform fulfills all core requirements of Assignment 2. By combining Fastify, PostgreSQL prepared transactions, idempotent journal logging, and robust concurrency controls, the system guarantees strong data consistency and durability across sharded databases under concurrent client load and severe process failures.
