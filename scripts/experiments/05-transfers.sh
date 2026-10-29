#!/usr/bin/env bash
# Experiment 5: local atomic transfer vs. cross-shard two-phase commit vs. abort.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

start_experiment 05-transfers
wait_gateway_ready

total_before_a="$(shard_total A)"
total_before_b="$(shard_total B)"
coordinator_before="$(psql_coord 'select count(*) from transactions;')"
say "shard totals before: A=$total_before_a B=$total_before_b"

say ""
say "--- local transfer A0400 -> A0401 (amount 11) ---"
local_from_before="$(balance_or_fail A0400)"
local_to_before="$(balance_or_fail A0401)"
local_response="$(api -X POST "$GATEWAY/v1/transfers" \
  -H 'content-type: application/json' \
  -H "idempotency-key: exp5-local-$(date +%s)" \
  -d '{"from":"A0400","to":"A0401","amount":11}')"
say "$local_response" | jq . | tee -a "$LOG_FILE"
local_from_after="$(balance_or_fail A0400)"
local_to_after="$(balance_or_fail A0401)"
coordinator_after="$(psql_coord 'select count(*) from transactions;')"

check "local transfer returned success" \
  "$([ "$(printf '%s' "$local_response" | jq -r '.status')" = "success" ] && echo 1 || echo 0)"
check "source decreased by exactly 11 ($local_from_before -> $local_from_after)" \
  "$([ "$((local_from_before - local_from_after))" -eq 11 ] && echo 1 || echo 0)"
check "destination increased by exactly 11 ($local_to_before -> $local_to_after)" \
  "$([ "$((local_to_after - local_to_before))" -eq 11 ] && echo 1 || echo 0)"
check "local transfer did not create a distributed transaction" \
  "$([ "$coordinator_before" = "$coordinator_after" ] && echo 1 || echo 0)"

say ""
say "--- cross-shard transfer A0400 -> A1400 (amount 13, shard A -> shard B) ---"
cross_from_before="$(balance_or_fail A0400)"
cross_to_before="$(balance_or_fail A1400)"
cross_key="exp5-cross-$(date +%s)"
cross_response="$(api -X POST "$GATEWAY/v1/transfers" \
  -H 'content-type: application/json' \
  -H "idempotency-key: $cross_key" \
  -d '{"from":"A0400","to":"A1400","amount":13}')"
say "$cross_response" | jq . | tee -a "$LOG_FILE"
tx_id="$(printf '%s' "$cross_response" | jq -r '.txId // empty')"
cross_status="$(wait_tx_completed "$tx_id" 30)"
say "$cross_status" | jq . | tee -a "$LOG_FILE"
cross_from_after="$(balance_or_fail A0400)"
cross_to_after="$(balance_or_fail A1400)"

check "cross-shard transfer committed" \
  "$([ "$(printf '%s' "$cross_response" | jq -r '.outcome')" = "COMMITTED" ] && echo 1 || echo 0)"
check "both participants voted YES" \
  "$([ "$(printf '%s' "$cross_status" | jq -c '.votes')" = '{"A":"YES","B":"YES"}' ] && echo 1 || echo 0)"
check "both participants acknowledged the commit" \
  "$([ "$(printf '%s' "$cross_status" | jq -c '.acks')" = '{"A":"DONE","B":"DONE"}' ] && echo 1 || echo 0)"
check "debit recorded exactly once ($cross_from_before -> $cross_from_after)" \
  "$([ "$((cross_from_before - cross_from_after))" -eq 13 ] && echo 1 || echo 0)"
check "credit recorded exactly once ($cross_to_before -> $cross_to_after)" \
  "$([ "$((cross_to_after - cross_to_before))" -eq 13 ] && echo 1 || echo 0)"

say ""
say "--- cross-shard transfer that the destination shard must reject ---"
abort_from_before="$(balance_or_fail A0400)"
abort_to_before="$(balance_or_fail A1400)"
abort_body="$OUT_DIR/abort-response.json"
abort_code="$(api -o "$abort_body" -w '%{http_code}' -X POST "$GATEWAY/v1/transfers" \
  -H 'content-type: application/json' \
  -H "idempotency-key: exp5-abort-$(date +%s)" \
  -d '{"from":"A0400","to":"A1400","amount":100000000}')"
jq . "$abort_body" | tee -a "$LOG_FILE"
abort_from_after="$(balance_or_fail A0400)"
abort_to_after="$(balance_or_fail A1400)"
abort_tx="$(jq -r '.details.txId // empty' "$abort_body" 2>/dev/null || true)"

check "overdraft was rejected with 409" "$([ "$abort_code" = "409" ] && echo 1 || echo 0)"
check "error code is INSUFFICIENT_FUNDS" \
  "$([ "$(jq -r '.code' "$abort_body")" = "INSUFFICIENT_FUNDS" ] && echo 1 || echo 0)"
check "source balance untouched ($abort_from_before -> $abort_from_after)" \
  "$([ "$abort_from_before" = "$abort_from_after" ] && echo 1 || echo 0)"
check "destination balance untouched ($abort_to_before -> $abort_to_after)" \
  "$([ "$abort_to_before" = "$abort_to_after" ] && echo 1 || echo 0)"
if [ -n "$abort_tx" ]; then
  abort_view="$(wait_tx_completed "$abort_tx" 30)"
  say "$abort_view" | jq . | tee -a "$LOG_FILE"
  check "the aborted transaction is recorded as ABORTED" \
    "$([ "$(printf '%s' "$abort_view" | jq -r '.outcome')" = "ABORTED" ] && echo 1 || echo 0)"
fi

say ""
total_after_a="$(shard_total A)"
total_after_b="$(shard_total B)"
say "shard totals after: A=$total_after_a B=$total_after_b"
# A cross-shard transfer deliberately moves money between shards, so the
# invariant that must hold is the sum over both shards, not each shard alone.
check "total money across both shards is conserved" \
  "$([ "$((total_before_a + total_before_b))" = "$((total_after_a + total_after_b))" ] && echo 1 || echo 0)"
check "shard A lost exactly the cross-shard amount (13)" \
  "$([ "$((total_before_a - total_after_a))" -eq 13 ] && echo 1 || echo 0)"
check "shard B gained exactly the cross-shard amount (13)" \
  "$([ "$((total_after_b - total_before_b))" -eq 13 ] && echo 1 || echo 0)"
check "no prepared transaction was left behind" \
  "$([ "$(prepared_count A)" = "0" ] && [ "$(prepared_count B)" = "0" ] && echo 1 || echo 0)"

finish_experiment
