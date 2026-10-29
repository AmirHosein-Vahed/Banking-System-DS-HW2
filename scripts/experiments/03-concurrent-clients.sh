#!/usr/bin/env bash
# Experiment 3: concurrent clients - read scalability and exact write accounting.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

start_experiment 03-concurrent-clients
wait_gateway_ready

say ""
say "--- 400 concurrent balance reads per shard (concurrency 50) ---"
for account in A0900 A1900; do
  output="$OUT_DIR/reads-$account.json"
  "$TSX" "$ROOT_DIR/scripts/load.ts" \
    --url "$GATEWAY" --action balance --account "$account" \
    --count 400 --concurrency 50 >"$output"
  jq . "$output" | tee -a "$LOG_FILE"
  check "$account: every read returned 200" \
    "$([ "$(jq -r '.statuses["200"] // 0' "$output")" = "400" ] && echo 1 || echo 0)"
  check "$account: reads finished under 5s" \
    "$([ "$(jq -r '.durationMs' "$output")" -lt 5000 ] && echo 1 || echo 0)"
done

say ""
say "--- 60 deposits and 60 withdrawals of 3 in parallel against A0900 ---"
before="$(balance_or_fail A0900)"
deposits_before="$(psql_shard A "select count(*) from ledger_entries where reason='deposit' and account_id='A0900';")"
withdrawals_before="$(psql_shard A "select count(*) from ledger_entries where reason='withdraw' and account_id='A0900';")"
"$TSX" "$ROOT_DIR/scripts/load.ts" --url "$GATEWAY" --action deposit --account A0900 \
  --amount 3 --count 60 --concurrency 20 >"$OUT_DIR/deposits.json" &
deposit_pid=$!
"$TSX" "$ROOT_DIR/scripts/load.ts" --url "$GATEWAY" --action withdraw --account A0900 \
  --amount 3 --count 60 --concurrency 20 >"$OUT_DIR/withdrawals.json" &
withdraw_pid=$!
wait "$deposit_pid"
wait "$withdraw_pid"

jq . "$OUT_DIR/deposits.json" | tee -a "$LOG_FILE"
jq . "$OUT_DIR/withdrawals.json" | tee -a "$LOG_FILE"
after="$(balance_or_fail A0900)"
deposits_after="$(psql_shard A "select count(*) from ledger_entries where reason='deposit' and account_id='A0900';")"
withdrawals_after="$(psql_shard A "select count(*) from ledger_entries where reason='withdraw' and account_id='A0900';")"

check "all 120 writes succeeded" \
  "$([ "$(jq -r '.statuses["200"] // 0' "$OUT_DIR/deposits.json")" = "60" ] &&
     [ "$(jq -r '.statuses["200"] // 0' "$OUT_DIR/withdrawals.json")" = "60" ] && echo 1 || echo 0)"
check "balance returned to its starting value ($before -> $after)" \
  "$([ "$before" = "$after" ] && echo 1 || echo 0)"
check "exactly 60 deposit entries were written" \
  "$([ "$((deposits_after - deposits_before))" -eq 60 ] && echo 1 || echo 0)"
check "exactly 60 withdrawal entries were written" \
  "$([ "$((withdrawals_after - withdrawals_before))" -eq 60 ] && echo 1 || echo 0)"

finish_experiment
