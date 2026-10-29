#!/usr/bin/env bash
# Experiment 7: many concurrent cross-shard transfers.
#
# 20 transfers in each direction run at the same time. The expected result is
# that every transfer commits, both balances return to their starting values
# (net zero) and the total amount of money in the system never changes.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

start_experiment 07-concurrent-transfers
wait_gateway_ready

from="A0900"
to="A1900"
count=20
concurrency=10

total_before_a="$(shard_total A)"
total_before_b="$(shard_total B)"
from_before="$(balance_or_fail "$from")"
to_before="$(balance_or_fail "$to")"
say "before: $from=$from_before $to=$to_before total=A:$total_before_a+B:$total_before_b"

start=$SECONDS
"$TSX" "$ROOT_DIR/scripts/load.ts" --url "$GATEWAY" --action transfer \
  --account "$from" --to "$to" --amount 1 --count "$count" --concurrency "$concurrency" \
  >"$OUT_DIR/forward.json" &
forward_pid=$!
"$TSX" "$ROOT_DIR/scripts/load.ts" --url "$GATEWAY" --action transfer \
  --account "$to" --to "$from" --amount 1 --count "$count" --concurrency "$concurrency" \
  >"$OUT_DIR/backward.json" &
backward_pid=$!
wait "$forward_pid"
wait "$backward_pid"
elapsed=$((SECONDS - start))

say ""
say "forward $from -> $to ($count transfers, concurrency $concurrency):"
jq . "$OUT_DIR/forward.json" | tee -a "$LOG_FILE"
say "backward $to -> $from ($count transfers, concurrency $concurrency):"
jq . "$OUT_DIR/backward.json" | tee -a "$LOG_FILE"
say "wall clock: ${elapsed}s"

forward_ok="$(jq -r '.statuses["200"] // 0' "$OUT_DIR/forward.json")"
backward_ok="$(jq -r '.statuses["200"] // 0' "$OUT_DIR/backward.json")"
check "all $count forward transfers committed" "$([ "$forward_ok" = "$count" ] && echo 1 || echo 0)"
check "all $count backward transfers committed" "$([ "$backward_ok" = "$count" ] && echo 1 || echo 0)"

from_after="$(balance_or_fail "$from")"
to_after="$(balance_or_fail "$to")"
say "after: $from=$from_after $to=$to_after"

check "source returned to its starting balance ($from_before -> $from_after)" \
  "$([ "$from_before" = "$from_after" ] && echo 1 || echo 0)"
check "destination returned to its starting balance ($to_before -> $to_after)" \
  "$([ "$to_before" = "$to_after" ] && echo 1 || echo 0)"

total_after_a="$(shard_total A)"
total_after_b="$(shard_total B)"
say "after: total=A:$total_after_a+B:$total_after_b"
check "money on shard A is conserved" "$([ "$total_before_a" = "$total_after_a" ] && echo 1 || echo 0)"
check "money on shard B is conserved" "$([ "$total_before_b" = "$total_after_b" ] && echo 1 || echo 0)"

check "no prepared transaction is left on shard A" "$([ "$(prepared_count A)" = "0" ] && echo 1 || echo 0)"
check "no prepared transaction is left on shard B" "$([ "$(prepared_count B)" = "0" ] && echo 1 || echo 0)"
check "the coordinator has no unresolved transaction" \
  "$([ "$(psql_coord "select count(*) from transactions where status <> 'COMPLETED';")" = "0" ] && echo 1 || echo 0)"

say ""
say "distributed transactions in this run:"
psql_coord "select outcome, count(*) from transactions
            where created_at > now() - interval '5 minutes'
            group by outcome order by outcome;" | tee -a "$LOG_FILE"

say ""
say "participant acknowledgements:"
psql_coord "select tx_id, shard_id, vote, ack from participants
            where tx_id in (select tx_id from transactions where created_at > now() - interval '5 minutes')
            order by tx_id, shard_id limit 8;" | tee -a "$LOG_FILE"

finish_experiment
