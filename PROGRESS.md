# Project Progress — Distributed Banking Platform

**Course:** Distributed Systems — Assignment 2
**Deadline:** 1405/08/15 ≈ **Friday 6 November 2026**
**Status date:** 2026-10-29
**Overall status:** Core platform and required experiments are complete. The
project is in the final packaging and submission stage.

---

## 1. Executive summary

The main Assignment 2 platform is implemented and verified:

- 2 independent PostgreSQL shards, each with 2 stateless application replicas.
- Shard-aware gateway with health checking and round-robin replica selection.
- Local banking operations and same-shard transfers with ACID guarantees.
- Cross-shard transfers using durable Two-Phase Commit and PostgreSQL prepared
  transactions.
- Coordinator recovery for scenarios A, B and C.
- CLI, Docker Compose topology, bootstrap/seed, CI, tests and documentation.
- All seven required experiments pass.

Remaining work is submission packaging:

1. Push the latest local commits.
2. Publish the Docker image to Docker Hub.
3. Produce the ≤10-page technical report PDF.
4. Record the ≤15-minute demo video.
5. Run a final clean end-to-end validation before submission.

**Estimated completion:** ~90%. The remaining 10% is publication/report/video,
not implementation.

---

## 2. Milestone status

| Milestone | Scope | Status |
| --- | --- | --- |
| M0 | Repository, TypeScript tooling, Compose skeleton | ✅ Complete |
| M1 | Shard schema/seed, balance/deposit/withdraw, ACID, concurrency, errors, logging | ✅ Complete |
| M2 | Shard map, routing, replica health, round-robin, failover, second shard | ✅ Complete |
| M3 | Same-shard transfer as one local transaction | ✅ Complete |
| M4 | Coordinator journal, 2PC prepare/commit, participant journal, status API | ✅ Complete |
| M5 | Recovery, fault injection, scenarios A/B/C, concurrent transfers | ✅ Complete |
| M6 | Hardening, tests, CI, experiments, documentation | ✅ Complete |
| M7 | Docker Hub, report, video, final submission | ⏳ In progress |

Implementation finished ahead of the plan's 3 November milestone.

---

## 3. Completed work

### 3.1 Architecture and infrastructure

- Two shards:
  - Shard A: `A0001–A1000`
  - Shard B: `A1001–A2000`
- Two replicas per shard (`a1`, `a2`, `b1`, `b2`) sharing one database per shard.
- Separate coordinator container and coordinator database.
- Single multi-stage Docker image; the Compose command selects the service role.
- Bootstrap applies idempotent SQL migrations and seeds 2,000 accounts at
  `SEED_BALANCE=1000`.
- PostgreSQL configured with `max_prepared_transactions=200` and
  `synchronous_commit=on`.

### 3.2 Shared kernel

- Typed application errors with stable error codes.
- Account ID, amount and money validation.
- Request IDs, transaction IDs, GIDs and payload hashing.
- Pino logging with request ID, client IP, action, account, result and latency.
- Environment parsing with Zod.
- Internal service client with shared token.
- Configurable concurrency limiter.
- Keyed mutex and semaphore.
- HTTP error mapping and request logging.

### 3.3 Accounts and local operations

- Balance, deposit, withdraw and same-shard transfer.
- Ordered `SELECT … FOR UPDATE` locking to avoid deadlocks.
- Conditional debit so balances cannot go negative.
- Ledger entries appended in the same database transaction.
- Idempotent client requests with payload-hash conflict detection.
- Shard ownership validation on every mutating path.
- Configurable maximum concurrent requests with `503 OVERLOADED`.

### 3.4 Routing and replication

- Versioned shard map in `config/shard-map.yaml`.
- Startup validation: contiguous ranges, complete `A0001–A2000` coverage, unique
  replicas.
- Binary-search account routing.
- Active replica health probes with failure threshold.
- Round-robin selection over healthy replicas of the owning shard.
- Shard client retry across replicas of the same shard.
- `503 SHARD_UNAVAILABLE` when no replica is healthy; no cross-shard fallback.
- `/v1/status` exposes shard-map version/fingerprint and replica health.

### 3.5 Two-Phase Commit

- Coordinator state machine:
  `INITIATED → PREPARING → PREPARED → COMMIT_DECIDED → COMPLETED`
  with the abort branch `PREPARING → ABORT_DECIDED → COMPLETED`.
- Durable coordinator journal: transactions, participants, votes,
  acknowledgements and event log.
- Participant journal plus native PostgreSQL prepared transactions.
- Durable decision written before phase two begins.
- Idempotent `COMMIT` / `ABORT` handling.
- Abort tombstone prevents a late prepare from committing.
- Recovery resolver on startup and every 5 seconds.
- Success returned only after every participant acknowledges commit; pending
  transfers return `202` with a queryable transaction id.
- Scenario A: one YES + one rejecting NO → abort all prepared participants.
- Scenario B: all prepared, coordinator crashes → recover and commit.
- Scenario C: commit decision durable, coordinator crashes before all acks →
  complete the recorded commit, never replace it with abort.

### 3.6 Concurrency hardening

- Coordinator mutex per transaction id.
- Coordinator serialisation per account pair in sorted order.
- Participant session advisory lock per transaction id.
- Prepare semaphore reserving connections for phase two
  (`DB_POOL_SIZE - 3`).
- `lock_timeout = 2s` on prepare.
- Journal rows locked with `FOR UPDATE`.
- Concurrent opposite transfers verified with exact balances and no leaked
  prepared transactions.

### 3.7 Client and operations

- `bankctl` CLI: balance, deposit, withdraw, transfer, status; `--wait`, `--json`,
  `--request-id`.
- Docker Compose topology for 3 databases, 4 replicas, coordinator, gateway,
  bootstrap and optional client.
- Make targets for lifecycle, tests, CLI and experiments.
- Load generator.
- Experiment scripts 01–07 with shared helpers and sequential runner.
- GitHub Actions CI for typecheck, lint, unit tests, build and Compose
  integration tests.

### 3.8 Documentation

- `README.md` — overview, API, CLI, configuration, tests, experiments,
  limitations.
- `docs/architecture.md` — components, data model, request flows, concurrency,
  durability.
- `docs/2pc-protocol.md` — protocol, journal schemas, recovery, failure matrix.
- `docs/experiments.md` — experiment procedures and observed output.
- `docs/requirements.md` — requirement-to-implementation traceability.
- `AGENTS.md` — onboarding and operational guidance for future sessions.

---

## 4. Verification evidence

Verified on 2026-10-29 against the current working tree.

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | ✅ Passing |
| Lint | `npm run lint` | ✅ Passing |
| Build | `npm run build` | ✅ Passing |
| Unit tests | `npm test` | ✅ 38/38 passing |
| Integration tests | `npm run test:integration` | ✅ 10/10 passing |
| Compose stack | `docker compose -f deploy/compose.yaml ps` | ✅ 9 running services healthy (bootstrap completed) |
| Experiment 1 | `make exp1` | ✅ All checks passed |
| Experiment 2 | `make exp2` | ✅ All checks passed |
| Experiment 3 | `make exp3` | ✅ All checks passed |
| Experiment 4 | `make exp4` | ✅ All checks passed |
| Experiment 5 | `make exp5` | ✅ All checks passed |
| Experiment 6 | `make exp6` | ✅ All checks passed |
| Experiment 7 | `make exp7` | ✅ All checks passed |

Latest experiment evidence:

| # | Artifact directory | Result |
| --- | --- | --- |
| 1 | `artifacts/20261029T191242-01-shard-distribution` | all checks passed |
| 2 | `artifacts/20261029T191242-02-replica-distribution` | all checks passed |
| 3 | `artifacts/20261029T191244-03-concurrent-clients` | all checks passed |
| 4 | `artifacts/20261029T191247-04-replica-failover` | all checks passed |
| 5 | `artifacts/20261029T191258-05-transfers` | all checks passed |
| 6 | `artifacts/20261029T191259-06-coordinator-recovery` | all checks passed |
| 7 | `artifacts/20261029T191317-07-concurrent-transfers` | all checks passed |

---

## 5. Deliverables status

| Deliverable | Status | Notes |
| --- | --- | --- |
| Source code on GitHub | 🟡 Mostly done | 16 local commits; `origin/main` contains `dc0cbbe`; local docs commits `04afcd4` (AGENTS.md) and this PROGRESS commit still need pushing. |
| Docker image on Docker Hub | ❌ Not started | Only `ds-banking:local` exists locally. |
| Technical report (≤10 A4 pages) | ❌ Not started | Source material is complete in `README.md` and `docs/`; PDF not produced. |
| Demo video (≤15 minutes) | ❌ Not started | Runbook order exists in `docs/requirements.md`; no recording or script file yet. |
| CI workflow | 🟡 Configured | Quality + Compose integration jobs exist; confirm they are green on the pushed commit. |
| Required experiments | ✅ Complete | All seven pass with stored evidence. |
| Bonuses I and II | ⛔ Out of scope | Do not implement unless scope is explicitly changed. |

---

## 6. Definition of done

### Implementation

- [x] Two shards with separate PostgreSQL databases and volumes.
- [x] Two replicas per shard; replicas hold no authoritative state.
- [x] Versioned shard map validated at startup; boundary routing verified.
- [x] Round-robin over healthy replicas; failover demonstrated.
- [x] Local operations satisfy A1 ACID, durability, error handling and logging.
- [x] Same-shard transfer is one atomic transaction.
- [x] Cross-shard transfer uses durable prepare/commit with votes and acks.
- [x] Decision is persisted before phase two.
- [x] Success is never reported before all participants confirm commit.
- [x] Recovery scenarios A, B and C pass.
- [x] Transaction status is queryable by ID.
- [x] Experiments 1–7 reproducible via `make expN`.
- [x] Unit and integration tests pass.
- [x] CI workflow defined.
- [x] Documentation complete.

### Submission

- [ ] Latest commits pushed to GitHub.
- [ ] Docker image pushed to Docker Hub and referenced in README.
- [ ] Technical report PDF produced (≤10 pages).
- [ ] Demo video recorded (≤15 minutes).
- [ ] Final clean-clone / clean-volume validation passed.
- [ ] Submission links collected: GitHub, Docker Hub, report, video.

---

## 7. Next steps

### Step 1 — Sync the repository

- [ ] Review `AGENTS.md` and `PROGRESS.md`, and commit any further updates.
- [ ] Push `main` so `origin/main` includes all documentation commits.
- [ ] Confirm the GitHub repository is public/accessible to the reviewers.
- [ ] Check GitHub Actions on the pushed commit.

### Step 2 — Publish the Docker image

- [ ] Choose the Docker Hub namespace and tag, for example
      `<dockerhub-user>/ds-banking:latest` and a version tag.
- [ ] Log in to Docker Hub.
- [ ] Build and tag:
      `docker build -t <dockerhub-user>/ds-banking:latest .`
- [ ] Push both `latest` and a version tag.
- [ ] Pull the published image on a clean machine or after removing the local
      image to verify it is self-contained.
- [ ] Update `README.md` with the image name and pull/run instructions.
- [ ] Optionally update Compose/README to show how to run the published image.

### Step 3 — Write the technical report

Suggested structure and page budget (≤10 A4 pages):

| Section | Pages |
| --- | --- |
| Architecture and process topology | 1.5 |
| Sharding, shard map, routing, replica selection, health | 1.5 |
| Concurrency control and A1 ACID/durability mapping | 1.5 |
| 2PC protocol, sequence diagram, state machine, durable ordering | 2.5 |
| Recovery scenarios A/B/C | 1.5 |
| Experiments 1–7 with numbers and evidence | 1.5 |
| Limitations and conclusion | 0.5 |

- [ ] Create a report outline/file (for example `docs/report-outline.md`).
- [ ] Add the 2PC sequence diagram and transaction state diagram.
- [ ] Include experiment tables/screenshots and exact artifact results.
- [ ] Document limitations honestly: single gateway, single coordinator, one DB
      per shard, no DB failover, trusted internal network.
- [ ] Export to PDF and verify it is ≤10 pages.
- [ ] Proofread names, ports, commands and experiment numbers.

### Step 4 — Prepare and record the demo video

- [ ] Create `docs/demo-script.md` with timings and exact commands.
- [ ] Run `make reset` before recording for deterministic seed balances.
- [ ] Rehearse once with a timer.
- [ ] Record in this order:
      1. Architecture and `make ps`.
      2. Shard routing and both databases.
      3. Replica distribution and concurrent operations (exp 2 + exp 3).
      4. Replica interruption (exp 4).
      5. Local vs cross-shard transfer (exp 5).
      6. Concurrent overlapping transfers (exp 7).
      7. Coordinator crash after prepare and after decision (exp 6).
      8. Final status, limitations and wrap-up.
- [ ] Keep the video ≤15 minutes.
- [ ] Upload to the required platform and store the link.

### Step 5 — Final validation

Run from a clean state:

```bash
make reset
make ps
npm run typecheck
npm run lint
npm test
npm run build
npm run test:integration
make exp-all
```

- [ ] All 9 long-running services become healthy and bootstrap completes.
- [ ] Typecheck, lint, build and unit tests pass.
- [ ] Integration tests pass (10/10).
- [ ] Experiments 01–07 pass sequentially.
- [ ] Review the newest `artifacts/` directories.
- [ ] Confirm no prepared transactions remain:
      `select count(*) from pg_prepared_xacts;` on both shard DBs.
- [ ] Confirm the working tree is clean and all doc changes are pushed.
- [ ] Optionally tag the submission commit, e.g. `v1.0.0`.

### Step 6 — Submit

- [ ] GitHub repository URL.
- [ ] Docker Hub image URL.
- [ ] Technical report PDF.
- [ ] Demo video link.
- [ ] Any LMS-specific metadata or naming requirements.

---

## 8. Known limitations

These are documented in the README and should stay explicit in the report/video:

- Single coordinator process: automatic recovery on restart, but no hot standby.
- Single gateway: a single point of failure while it is down.
- No database replication or database failover; each shard has one database.
- Round robin ignores in-flight request counts.
- Internal network is trusted (`INTERNAL_TOKEN`, plain HTTP); no client
  authentication, TLS or per-customer rate limiting.
- Fault injection (`FAULTS`) is demo-only and must be empty outside experiments.
- Expert Bonus I and Bonus II are not implemented.

---

## 9. Open decisions

- Docker Hub namespace/image name to use for submission.
- Final report format/template and whether diagrams are exported as images or
  Mermaid.
- Video hosting location and whether a scripted narration is preferred.
- Whether to create a `v1.0.0` git tag for the submission.

---

## 10. Useful commands

```bash
# Lifecycle
make up
make ps
make logs
make reset
make down

# Quality gates
npm run typecheck
npm run lint
npm test
npm run build
npm run test:integration

# Single test
npx vitest run test/unit/money.test.ts

# CLI
make cli ARGS="balance A0500"
make cli ARGS="transfer A0500 A1500 300 --wait"

# Experiments
make exp1
make exp2
make exp3
make exp4
make exp5
make exp6
make exp7
make exp-all
```
