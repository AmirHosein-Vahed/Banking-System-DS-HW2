#!/usr/bin/env bash
# Experiment 2: read traffic is balanced across the healthy replicas of a shard.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

start_experiment 02-replica-distribution
wait_gateway_ready

run_reads() {
  local account="$1"
  local count="$2"
  local output="$OUT_DIR/reads-$account.json"
  "$TSX" "$ROOT_DIR/scripts/load.ts" \
    --url "$GATEWAY" --action balance --account "$account" \
    --count "$count" --concurrency 20 >"$output"
  jq . "$output" | tee -a "$LOG_FILE"
  jq -r '.replicas | to_entries[] | "\(.key)=\(.value)"' "$output"
}

say ""
say "200 reads of A0500 (shard A):"
result_a="$(run_reads A0500 200)"
say "$result_a"
a1="$(printf '%s\n' "$result_a" | awk -F= '$1=="a1"{print $2}')"
a2="$(printf '%s\n' "$result_a" | awk -F= '$1=="a2"{print $2}')"
check "all shard A reads succeeded" "$([ "$(jq -r '.statuses["200"] // 0' "$OUT_DIR/reads-A0500.json")" = "200" ] && echo 1 || echo 0)"
check "shard A reads reached a1 and a2" "$([ -n "$a1" ] && [ -n "$a2" ] && [ "$a1" -gt 0 ] && [ "$a2" -gt 0 ] && echo 1 || echo 0)"
check "shard A split within 25/75" "$([ "$a1" -ge 50 ] && [ "$a2" -ge 50 ] && echo 1 || echo 0)"

say ""
say "200 reads of A1500 (shard B):"
result_b="$(run_reads A1500 200)"
say "$result_b"
b1="$(printf '%s\n' "$result_b" | awk -F= '$1=="b1"{print $2}')"
b2="$(printf '%s\n' "$result_b" | awk -F= '$1=="b2"{print $2}')"
check "all shard B reads succeeded" "$([ "$(jq -r '.statuses["200"] // 0' "$OUT_DIR/reads-A1500.json")" = "200" ] && echo 1 || echo 0)"
check "shard B reads reached b1 and b2" "$([ -n "$b1" ] && [ -n "$b2" ] && [ "$b1" -gt 0 ] && [ "$b2" -gt 0 ] && echo 1 || echo 0)"
check "shard B split within 25/75" "$([ "$b1" -ge 50 ] && [ "$b2" -ge 50 ] && echo 1 || echo 0)"

say ""
say "no request was served by a replica of the wrong shard (x-shard-id checked):"
for i in 1 2 3 4 5; do
  s="$(shard_of A0500)"
  r="$(replica_of A0500)"
  say "  A0500 -> shard $s replica $r"
  check "A0500 served by shard A" "$([ "$s" = "A" ] && echo 1 || echo 0)"
done

finish_experiment
