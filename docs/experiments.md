# Experiments

The seven experiments required by the assignment are scripts under
[`scripts/experiments/`](../scripts/experiments). Each one:

* starts by checking that the gateway is ready,
* prints one `PASS`/`FAIL` line per claim,
* writes its log and JSON evidence to
  `artifacts/<timestamp>-<script-name>/experiment.log`,
* exits with a non-zero status if any claim failed.

Run them **sequentially** (several stop or crash containers), with the stack
already up:

```bash
make up
make exp1
make exp2
make exp3
make exp4
make exp5
make exp6
make exp7
```

or `bash scripts/experiments/01-shard-distribution.sh`, etc. Total runtime is
about two minutes. All numbers below come from runs on the reference machine.

---

## 1. Shard distribution

**Script:** `01-shard-distribution.sh`
**Shows:** accounts are stored in the assigned database and the gateway routes
by ownership.

The script reads boundary and interior accounts (`A0001`, `A0002`, `A0500`,
`A0999`, `A1000`, `A1001`, `A1200`, `A1500`, `A1999`, `A2000`) and checks the
`x-shard-id` of every response against the expected owner.

Observed:

```
account  expected  observed  replica  balance
A0001    A         A         a1       1000
A1000    A         A         a2       1000
A1001    B         B         b1       1000
A2000    B         B         b2       1000
...
PASS  A0001 is owned by shard A
...
result: all checks passed
```

The `/v1/status` section shows the map version, fingerprint
(`ed8638f250dc8a59`) and the four healthy replicas.

## 2. Replica load distribution

**Script:** `02-replica-distribution.sh`
**Shows:** many requests for one shard's accounts are handled by both replicas,
and logs/headers identify the replica.

200 reads of `A0500` (shard A) and 200 reads of `A1500` (shard B) are issued
with concurrency 20; the script counts the `x-replica-id` of every response.

Observed:

```
shard A: a1 = 100, a2 = 100
shard B: b1 = 100, b2 = 100
PASS  shard A reads reached a1 and a2
PASS  shard B reads reached b1 and b2
PASS  A0500 served by shard A   (five samples)
```

The same information is in the shard logs (`replica` field) and in the gateway's
`response` events.

## 3. Concurrent replica operations

**Script:** `03-concurrent-clients.sh`
**Shows:** concurrent clients through different replicas produce correct
balances (no lost updates).

* 400 balance reads per shard with concurrency 50 (load + replica distribution
  under concurrency).
* 60 deposits and 60 withdrawals of 3, in parallel, on the same account
  (`A0900`), each write randomly landing on `a1` or `a2`.

Observed:

```
A0900: 400/400 reads, ~1.0 s, a1=204 a2=196
A1900: 400/400 reads, ~0.9 s
deposits:   60/60, a1=26 a2=34
withdrawals: 60/60, a1=26 a2=34
PASS  balance returned to its starting value (1000 -> 1000)
PASS  exactly 60 deposit entries were written
PASS  exactly 60 withdrawal entries were written
```

If the replicas did not share a consistent view, or if the updates were not
serialised, 120 concurrent writes would not return exactly to the starting
balance.

## 4. Replica interruption

**Script:** `04-replica-failover.sh`
**Shows:** stopping one replica under load makes the gateway stop selecting it
and use the other healthy replica of the same shard.

1. `docker compose stop shard-a-2`.
2. Poll `/v1/status` until `a2.healthy == false` and measure detection time.
3. Issue 50 reads while it is down.
4. `docker compose start shard-a-2`, poll until healthy again, issue 50 reads.

Observed:

```
gateway marked a2 unhealthy after 5s
PASS  all reads still succeed with one replica down
PASS  no request was routed to the dead replica
PASS  reads were served by a1
a2 healthy again after 3s
PASS  both replicas serve traffic again
detection=5s recovery=3s
```

Detection is bounded by `HEALTH_INTERVAL_MS × HEALTH_FAILURE_THRESHOLD`
(2 s × 3). The script leaves both replicas running.

## 5. Local and cross-shard transfers

**Script:** `05-transfers.sh`
**Shows:** same-shard transfers are one local transaction; cross-shard
transfers need 2PC; a participant rejection aborts the whole transfer.

* Local: `A0400 → A0401`, 11. Checks exact deltas and that the coordinator
  journal count did **not** change (no distributed transaction was created).
* Cross-shard: `A0400 → A1400`, 13. Checks `200`, `outcome=COMMITTED`,
  votes `{A:YES,B:YES}`, acks `{A:DONE,B:DONE}`, exact deltas and the final
  `GET /v1/transactions/{txId}`.
* Abort: `A0400 → A1400`, 100,000,000. Checks `409 INSUFFICIENT_FUNDS`, unchanged
  balances and that the transaction is `ABORTED`.

Observed:

```
PASS  source decreased by exactly 11 (1000 -> 989)
PASS  local transfer did not create a distributed transaction
PASS  both participants voted YES
PASS  debit recorded exactly once (989 -> 976)
PASS  credit recorded exactly once (1000 -> 1013)
PASS  overdraft was rejected with 409
PASS  source balance untouched (976 -> 976)
PASS  total money across both shards is conserved
PASS  shard A lost exactly the cross-shard amount (13)
PASS  shard B gained exactly the cross-shard amount (13)
```

A cross-shard transfer legitimately moves money between shards, so per-shard
totals change by the transfer amount while the sum over both shards is constant.

## 6. Interrupted distributed transaction

**Script:** `06-coordinator-recovery.sh`
**Shows:** the coordinator recovers from a crash before the decision and after
the durable commit decision.

The script uses the `FAULTS` hook, which makes the coordinator exit with code
137 at a precise point. It waits for the crash, inspects the durable state, then
restarts the coordinator without faults and waits for the resolver to finish.

### Scenario B — crash after every participant prepared

```
restart coordinator with FAULTS=crash_after_prepare
client POST /v1/transfers -> 503 COORDINATOR_UNAVAILABLE
coordinator exit code 137
transaction status in coordinator DB: PREPARED (no decision)
shard A: 1 prepared transaction
shard B: 1 prepared transaction
client-visible balances unchanged while prepared
restart with FAULTS=
PASS  recovered transaction is COMPLETED
PASS  the durable decision was honoured (COMMITTED)
PASS  debit applied exactly once (976 -> 959)
PASS  credit applied exactly once (1034 -> 1051)
PASS  no prepared transaction is left on shard A
PASS  no prepared transaction is left on shard B
```

### Scenario C — crash after the durable COMMIT decision

```
restart coordinator with FAULTS=crash_after_decision
client POST /v1/transfers -> 503 COORDINATOR_UNAVAILABLE
coordinator exit code 137
transaction status: COMMIT_DECIDED (before any participant commit)
restart with FAULTS=
PASS  recovered transaction is COMPLETED
PASS  the durable decision was honoured (COMMITTED)
PASS  debit applied exactly once (959 -> 940)
PASS  credit applied exactly once (1051 -> 1070)
```

Scenario A (one shard rejects) is covered by experiment 5, which shows the
already-prepared destination being rolled back.

## 7. Concurrent cross-shard transfers

**Script:** `07-concurrent-transfers.sh`
**Shows:** overlapping accounts under concurrent 2PC keep balances, states and
total money correct.

20 transfers `A0900 → A1900` and 20 transfers `A1900 → A0900`, amount 1, each
batch with concurrency 10, both batches at the same time, so every transaction
touches the same two accounts.

Observed:

```
wall clock: 2s
PASS  all 20 forward transfers committed
PASS  all 20 backward transfers committed
PASS  source returned to its starting balance (1000 -> 1000)
PASS  destination returned to its starting balance (1000 -> 1000)
PASS  money on shard A is conserved
PASS  money on shard B is conserved
PASS  no prepared transaction is left on shard A
PASS  no prepared transaction is left on shard B
PASS  the coordinator has no unresolved transaction
```

The script also prints the outcomes in the coordinator journal
(`40 COMMITTED`) and a sample of participant votes/acks (`YES/YES`, `DONE/DONE`).

### Why this experiment is the interesting one

Prepared transactions keep row locks until phase two. A naive implementation
that lets 40 concurrent transfers prepare against the same two accounts will
fill each shard's connection pool with prepares waiting on locks and then have
no connection left to resolve them. The failure mode is timeouts (`fetch
failed` at the client), not corrupt data.

This was observed during development and is fixed by three mechanisms that the
experiment now exercises together:

1. coordinator-side serialisation per account (sorted lock order),
2. `lock_timeout` on prepare,
3. a prepare semaphore that reserves connections for phase two.

The evidence of the fix is visible in the run: 40/40 transfers, 2 s wall clock,
zero prepared transactions left, zero unresolved transactions, and exactly two
acknowledgement events per transaction in the coordinator log.

---

## Reading the results

* `PASS`/`FAIL` lines are the authoritative result; the JSON sections are
  supporting evidence and are also stored in `artifacts/`.
* A failed experiment exits non-zero, so a sequence like
  `for f in scripts/experiments/*.sh; do bash "$f" || break; done` stops at the
  first regression.
* Experiment 6 leaves the coordinator running **without** fault injection even
  if a check fails (a shell `trap` restores it).
* Experiment 4 leaves `shard-a-2` running.
* Balances are mutated by the experiments. Run `make reset` to reseed.
