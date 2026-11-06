# Technical Report: Distributed Banking Platform

**Course:** Distributed Systems — Assignment 2
**Date:** 2026-11-06

---

## 1. Introduction

This report outlines the design and implementation of a sharded, replicated banking platform supporting atomic cross-shard transfers using Two-Phase Commit (2PC). The system aims for high availability and strict consistency for banking operations, ensuring money is never created, lost, or incorrectly transferred during concurrent operations or partial system failures.

## 2. Architecture and Process Topology

The platform consists of several loosely coupled services orchestrated by Docker Compose:

- **Gateway (:8080):** Serves as the public API entrypoint. It performs shard-aware routing, replica health monitoring, and round-robin load balancing.
- **Shard Replicas (:8080):** Stateless application nodes that perform local account operations and participate in 2PC. There are two replicas per shard (a1, a2 for Shard A; b1, b2 for Shard B).
- **Coordinator (:8081):** Manages the 2PC state machine for cross-shard transfers, maintaining a durable journal of transaction outcomes.
- **Databases:** Three distinct PostgreSQL 17 instances (one per shard, one for the coordinator).

## 3. Sharding, Routing, and Consistency

### 3.1 Partitioning
Accounts are partitioned using a range-based strategy defined in `config/shard-map.yaml`. Shard A owns `A0001–A1000`, and Shard B owns `A1001–A2000`. This map is loaded and validated by all services at startup to ensure contiguous coverage and uniqueness.

### 3.2 Routing and Load Balancing
The Gateway resolves an account ID to a shard using binary search over the range map. It maintains a `HealthRegistry` populated by active `/healthz` probes. If a replica fails (threshold: 3 failures), it is removed from the rotation and traffic is distributed across the remaining healthy replicas via round-robin.

### 3.3 Concurrency Control
Local operations (deposits, withdrawals, same-shard transfers) are ACID-compliant within a single PostgreSQL transaction:
1.  **Deadlock Prevention:** Accounts are always locked in ascending order of their account IDs.
2.  **Conditional Updates:** Balances are updated with a check (`balance >= amount`) to prevent negative balances.
3.  **Idempotency:** Client requests are recorded with a payload hash to prevent double-processing.

## 4. Two-Phase Commit (2PC) Protocol

Cross-shard transfers utilize a standard 2PC protocol to ensure atomicity across independent databases.

### 4.1 Phase 1 (Prepare)
The coordinator sends a `PREPARE` RPC to each participant shard.
1.  **Participant Action:** Shards lock the involved accounts and the transaction GID (using session advisory locks).
2.  **Durable Prepare:** The participant writes the operation (debit/credit) and ledger entries, then executes `PREPARE TRANSACTION '<gid>'`.
3.  **Vote:** If successful, the shard replies `YES`; otherwise, it replies `NO` or times out.

### 4.2 Phase 2 (Commit/Abort)
The coordinator decides based on the votes:
- **All YES:** Records `COMMIT_DECIDED` in its durable journal and sends `COMMIT` to all.
- **Any NO or Timeout:** Records `ABORT_DECIDED` and sends `ABORT` to all.
- **Idempotency:** Participants use `COMMIT PREPARED` / `ROLLBACK PREPARED` and verify the GID state to ensure idempotency.

### 4.3 Recovery
The coordinator maintains a persistent transaction journal. Upon restart, a background resolver scans the journal for `PREPARED` (but not yet decided) transactions and completes them based on the recorded outcome or aborts those missing a `PREPARED` vote.

## 5. Experimental Results

The platform was verified against seven core scenarios:
1.  **Shard Distribution:** Correct account routing.
2.  **Replica Distribution:** Traffic spread over replicas; logs verified.
3.  **Concurrent Operations:** 120 concurrent writes on a single account return the exact starting balance.
4.  **Replica Failover:** Gateway removed the dead replica within 5s; resumed traffic after restart.
5.  **Local vs. Cross-Shard Transfers:** Correct conservation of funds, with cross-shard transfers using 2PC.
6.  **Coordinator Crash:**
    - Scenario B (Crash after prepare): Recovery completed the commit.
    - Scenario C (Crash after durable commit): Recovery honored the commit.
7.  **Concurrent Cross-Shard Transfers:** All transfers committed successfully; balances conserved.

## 6. Limitations

- **SPOF:** Both the single gateway and the single coordinator instance are points of failure.
- **Database Scalability:** Each shard is constrained by the performance of its single PostgreSQL instance.
- **Performance:** 2PC adds latency due to durable journaling and network round-trips for the prepare phase.
