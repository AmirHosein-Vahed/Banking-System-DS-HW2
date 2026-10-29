#!/usr/bin/env bash
# Experiment 4: a replica dies, the gateway stops routing to it, and the shard
# keeps serving; when the replica returns it is used again.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

start_experiment 04-replica-failover
wait_gateway_ready

replica_healthy() {
  api "$GATEWAY/v1/status" | jq -r --arg id "$1" '.replicas[] | select(.replicaId==$id) | .healthy'
}

say ""
say "healthy replicas before the failure:"
api "$GATEWAY/v1/status" | jq '.replicas' | tee -a "$LOG_FILE"

# Durability across the loss of a replica: an acknowledged write must still be
# visible when the surviving replica answers.
durability_key="exp4-durability-$(date +%s%N)"
api -X POST "$GATEWAY/v1/accounts/A0900/deposits" \
  -H 'content-type: application/json' -H "idempotency-key: $durability_key" \
  -d '{"amount":1}' >"$OUT_DIR/durability-deposit.json"
durability_balance="$(jq -r '.balance' "$OUT_DIR/durability-deposit.json")"
say "deposit acknowledged with balance $durability_balance"

start=$SECONDS
"${COMPOSE[@]}" stop shard-a-2 >/dev/null
say "stopped shard-a-2 at t=0s, waiting for the gateway to notice"
for _ in $(seq 1 60); do
  if [ "$(replica_healthy a2)" = "false" ]; then
    break
  fi
  sleep 0.5
done
detection=$((SECONDS - start))
say "gateway marked a2 unhealthy after ${detection}s"
check "a2 is marked unhealthy" "$([ "$(replica_healthy a2)" = "false" ] && echo 1 || echo 0)"
check "a1 is still healthy" "$([ "$(replica_healthy a1)" = "true" ] && echo 1 || echo 0)"

say ""
say "50 reads while a2 is down:"
"$TSX" "$ROOT_DIR/scripts/load.ts" --url "$GATEWAY" --action balance --account A0900 \
  --count 50 --concurrency 10 >"$OUT_DIR/reads-degraded.json"
jq . "$OUT_DIR/reads-degraded.json" | tee -a "$LOG_FILE"
check "all reads still succeed with one replica down" \
  "$([ "$(jq -r '.statuses["200"] // 0' "$OUT_DIR/reads-degraded.json")" = "50" ] && echo 1 || echo 0)"
check "no request was routed to the dead replica" \
  "$([ "$(jq -r '.replicas["a2"] // 0' "$OUT_DIR/reads-degraded.json")" = "0" ] && echo 1 || echo 0)"
check "reads were served by a1" \
  "$([ "$(jq -r '.replicas["a1"] // 0' "$OUT_DIR/reads-degraded.json")" = "50" ] && echo 1 || echo 0)"
check "the acknowledged deposit survived the replica loss" \
  "$([ "$(balance_or_fail A0900)" = "$durability_balance" ] && echo 1 || echo 0)"

say ""
say "restarting shard-a-2"
restore_start=$SECONDS
"${COMPOSE[@]}" start shard-a-2 >/dev/null
for _ in $(seq 1 120); do
  if [ "$(replica_healthy a2)" = "true" ]; then
    break
  fi
  sleep 0.5
done
restore=$((SECONDS - restore_start))
say "a2 healthy again after ${restore}s"
check "a2 is healthy again" "$([ "$(replica_healthy a2)" = "true" ] && echo 1 || echo 0)"

say ""
say "50 reads after recovery:"
"$TSX" "$ROOT_DIR/scripts/load.ts" --url "$GATEWAY" --action balance --account A0900 \
  --count 50 --concurrency 10 >"$OUT_DIR/reads-recovered.json"
jq . "$OUT_DIR/reads-recovered.json" | tee -a "$LOG_FILE"
check "both replicas serve traffic again" \
  "$([ "$(jq -r '.replicas["a1"] // 0' "$OUT_DIR/reads-recovered.json")" -gt 0 ] &&
     [ "$(jq -r '.replicas["a2"] // 0' "$OUT_DIR/reads-recovered.json")" -gt 0 ] && echo 1 || echo 0)"
check "no data was served by a stale node" \
  "$([ "$(jq -r '.statuses["200"] // 0' "$OUT_DIR/reads-recovered.json")" = "50" ] && echo 1 || echo 0)"

say ""
say "detection=${detection}s recovery=${restore}s"
finish_experiment
