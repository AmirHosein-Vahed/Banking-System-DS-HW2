# AGENTS.md — Distributed Banking Platform

## Project context

Assignment 2: a sharded, replicated banking backend with 2PC for cross-shard
transfers. **Main assignment only — Expert Bonus I (live re-sharding) and Bonus
II (self-healing) are explicitly out of scope.** Deadline: **2026-11-06**.

- Shard A owns `A0001–A1000`; Shard B owns `A1001–A2000`.
- Two stateless application replicas per shard share one PostgreSQL database per
  shard. Replicas never hold authoritative balances.
- Gateway owns public routing; coordinator has its own container and database.
- Cross-shard transfers use PostgreSQL prepared transactions plus durable
  participant/coordinator journals.
- Stack: TypeScript (CommonJS), Node 24, Fastify, `pg` (no ORM), Zod, Pino,
  Vitest, PostgreSQL 17, Docker Compose.

Historical implementation plan (outside the repo):
`/home/ah/.opencode/plan/ds-assignment2-banking-plan.md`.
The current code, `README.md` and `docs/requirements.md` are the source of truth
when they conflict with that plan.

## Current stage (2026-10-29)

Completed: full platform, CLI, migrations/seed, Compose stack, CI, docs, 38 unit
tests, 10 integration tests, experiments 01–07. Git `main` is pushed to
`origin/main` (GitHub).

Remaining deliverables, in order:

1. Build/tag/push the Docker image to Docker Hub and update the image reference
   in the README (only `ds-banking:local` exists locally).
2. Write the ≤10-page technical report PDF using `docs/architecture.md`,
   `docs/2pc-protocol.md` and `docs/experiments.md`.
3. Record the ≤15-minute demo video (suggested order is in
   `docs/requirements.md`).
4. Do a final `make reset` + `make exp-all` + `npm run test:integration` run
   before recording, for fresh evidence.

Do not expand scope into the bonuses or add unrelated features during final
packaging.

## Commands

```bash
cp .env.example .env          # first run only
make up                       # build + start the stack (uses deploy/compose.yaml)
make ps                       # all services should be healthy
make reset                    # down -v + up; wipes data and reseeds 2,000 accounts
make down
make logs
make cli ARGS="balance A0500"

npm test                      # unit suite; no Docker required
npm run test:integration      # integration suite against a running stack
npm run typecheck
npm run lint
npm run build                 # tsc -> dist/ (tests excluded by tsconfig)
```

Run one unit test: `npx vitest run test/unit/money.test.ts`.
Run one integration test:
`RUN_INTEGRATION=1 npx vitest run test/integration/api.test.ts -t "name"`.

Integration tests do **not** start containers. They hit `GATEWAY_URL`
(default `http://localhost:8080`), so run `make up` first. Without
`RUN_INTEGRATION=1` they silently skip when the gateway is down.

Experiments (must run sequentially; they mutate balances and stop/crash
containers):

```bash
make exp1   # then exp2, ..., exp7 in order
make exp-all
```

Each script writes evidence to `artifacts/<timestamp>-<name>/` and exits
non-zero on a failed check. `artifacts/` is ignored by git.

## Architecture map

- `src/apps/*` — composition roots only:
  `gateway` (public :8080), `shard` (internal :8080), `coordinator`
  (internal :8081), `bootstrap`, `cli`.
- `src/modules/accounts` — local balance/deposit/withdraw/same-shard transfer.
- `src/modules/routing` — shard map, health registry, round-robin shard client.
- `src/modules/participation` — participant side of 2PC.
- `src/modules/coordination` — coordinator state machine, journal, resolver.
- `src/shared` — errors, money/IDs, logging, env, HTTP, concurrency helpers.
- `migrations/{shard,coordinator}` — applied by `bootstrap`; tracked in
  `schema_migrations`. Add a new migration file instead of editing an applied one.
- `config/shard-map.yaml` — must remain contiguous and cover exactly
  `A0001–A2000`; `ShardMap` validates this at startup.
- `deploy/compose.yaml` is the real Compose file; the root has no
  `compose.yaml`. One image serves every role; the Compose command selects it.

Dependency rule: imports point inward, `apps → adapters → application → domain`.
Modules must not import another module's adapters; only `src/apps/*` constructs
concrete adapters.
`dependency-cruiser` is present in devDependencies but is **not** wired into CI,
so enforce this manually.

## Correctness invariants

- Never route an account to a non-owning shard. If the owning shard has no
  healthy replica, return `503 SHARD_UNAVAILABLE`; do not fall back globally.
- Cross-shard success is reported only after every participant acknowledges
  `COMMIT`. A durable decision without all acks is `202` + queryable `PENDING`.
- Coordinator writes `COMMIT_DECIDED`/`ABORT_DECIDED` durably before phase two;
  recovery replays only the recorded decision and runs with `allowFaults=false`.
- Participant prepare order is `[toShard, fromShard]` so scenario A produces a
  prepared YES followed by a rejecting NO.
- Local writes use one PostgreSQL transaction: lock accounts in ascending id
  order, conditional debit (`balance >= amount`), ledger append, idempotent
  `client_requests` row with payload hash.
- Do not insert request-id dedupe rows inside a prepared transaction; a duplicate
  prepare would block on the unique index.

## Operational gotchas

- `FAULTS=crash_after_prepare` / `crash_after_decision` are demo-only; keep it
  empty in normal runs. A simulated crash exits with code 137.
- After a crash, `docker compose up -d coordinator` can leave the container
  `Created`. Use
  `docker compose -f deploy/compose.yaml up -d --force-recreate --no-deps coordinator`
  and restart with `FAULTS=` to recover.
- `docker compose ps -q` omits exited crash containers; use `ps --all --quiet`
  when inspecting exit codes.
- Compose has no `restart:` policy on purpose, so failover/experiment containers
  stay stopped until explicitly restarted.
- `make up` preserves existing volumes. Use `make reset` when a fresh seed or
  schema replay is needed.
- PostgreSQL runs with `max_prepared_transactions=200` and
  `synchronous_commit=on`. Do not weaken either. Check leaked prepared
  transactions with `select * from pg_prepared_xacts` inside a shard DB.
- `PREPARE TRANSACTION` takes a literal GID, not a bind parameter; keep all GID
  handling inside `pg-prepared-xact.ts`.
- Health split: `/healthz` must not depend on other services; dependency checks
  belong in `/readyz`. The coordinator is not ready until its startup recovery
  sweep finishes.

## Repo conventions

- Strict TypeScript (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`);
  no `any`; parse external input with Zod before use.
- Domain errors are typed `AppError`s; only HTTP adapters map them to status
  codes.
- Keep generated/build output (`dist/`, `artifacts/`), `.env`, and the course
  PDFs out of git.
- When behavior changes, update the relevant traceability row in
  `docs/requirements.md` and the README if the public API/config changes.
- CI runs typecheck → lint → unit tests → build, then a Compose integration job.
