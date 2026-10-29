#!/usr/bin/env bash
# Experiment 6: coordinator crash before and after the durable decision.
#
#   Scenario B - crash after every participant prepared (no decision yet):
#                recovery must roll forward and commit exactly once.
#   Scenario C - crash after the COMMIT_DECIDED record was made durable:
#                recovery must finish phase two and commit exactly once.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

start_experiment 06-coordinator-recovery

# Never leave the coordinator running with fault injection enabled.
restore_coordinator() {
  say "restoring the coordinator without fault injection"
  restart_coordinator "" || true
}
trap restore_coordinator EXIT

wait_gateway_ready

scenario() {
  local name="$1"
  local faults="$2"
  local amount="$3"
  local from="$4"
  local to="$5"

  say ""
  say "--------------------------------------------------------------"
  say "scenario $name: FAULTS=$faults"
  say "--------------------------------------------------------------"
  restart_coordinator "$faults"

  local before_from before_to
  before_from="$(balance_or_fail "$from")"
  before_to="$(balance_or_fail "$to")"

  local request_key="exp6-${name}-$(date +%s%N)"
  local code
  code="$(api -o "$OUT_DIR/$name-response.json" -w '%{http_code}' --max-time 20 \
    -X POST "$GATEWAY/v1/transfers" \
    -H 'content-type: application/json' \
    -H "idempotency-key: $request_key" \
    -d "{\"from\":\"$from\",\"to\":\"$to\",\"amount\":$amount}" || true)"
  say "client saw HTTP $code (503 is expected: the coordinator died mid-transaction)"
  jq . "$OUT_DIR/$name-response.json" 2>/dev/null | tee -a "$LOG_FILE" || true

  check "coordinator process died because of $faults" \
    "$(wait_coordinator_exit 30 && echo 1 || echo 0)"
  local exit_code
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$(service_id coordinator)")"
  say "coordinator exit code: $exit_code"
  check "exit code is 137 (simulated crash)" "$([ "$exit_code" = "137" ] && echo 1 || echo 0)"

  local tx_id
  tx_id="$(psql_coord "select tx_id from transactions where client_request_id = '$request_key';")"
  say "transaction id: $tx_id"
  check "the transaction is durably recorded" "$([ -n "$tx_id" ] && echo 1 || echo 0)"

  say "durable coordinator state after the crash:"
  psql_coord "select tx_id, status, outcome from transactions where tx_id = '$tx_id';" | tee -a "$LOG_FILE"
  local phase
  phase="$(psql_coord "select status from transactions where tx_id = '$tx_id';")"

  if [ "$faults" = "crash_after_prepare" ]; then
    check "no commit/abort decision was recorded yet" \
      "$([ "$phase" = "PREPARED" ] && echo 1 || echo 0)"
    say "prepared transactions on each shard:"
    psql_shard A "select gid from pg_prepared_xacts order by gid;" | tee -a "$LOG_FILE"
    psql_shard B "select gid from pg_prepared_xacts order by gid;" | tee -a "$LOG_FILE"
    check "both shards hold a prepared transaction" \
      "$([ "$(prepared_count A)" -ge 1 ] && [ "$(prepared_count B)" -ge 1 ] && echo 1 || echo 0)"
    check "the client-visible balances are unchanged while prepared" \
      "$([ "$before_from" = "$(balance_or_fail "$from")" ] && echo 1 || echo 0)"
  else
    check "COMMIT_DECIDED is durable before any participant committed" \
      "$([ "$phase" = "COMMIT_DECIDED" ] && echo 1 || echo 0)"
  fi

  say ""
  say "restarting the coordinator; the resolver must finish the transaction"
  restart_coordinator ""
  local view
  view="$(wait_tx_completed "$tx_id" 60)"
  say "$view" | jq . | tee -a "$LOG_FILE"

  check "recovered transaction is COMPLETED" \
    "$([ "$(printf '%s' "$view" | jq -r '.status')" = "COMPLETED" ] && echo 1 || echo 0)"
  check "the durable decision was honoured (COMMITTED)" \
    "$([ "$(printf '%s' "$view" | jq -r '.outcome')" = "COMMITTED" ] && echo 1 || echo 0)"
  check "every participant acknowledged" \
    "$([ "$(printf '%s' "$view" | jq -c '.acks')" = '{"A":"DONE","B":"DONE"}' ] && echo 1 || echo 0)"

  local after_from after_to
  after_from="$(balance_or_fail "$from")"
  after_to="$(balance_or_fail "$to")"
  check "debit applied exactly once ($before_from -> $after_from)" \
    "$([ "$((before_from - after_from))" -eq "$amount" ] && echo 1 || echo 0)"
  check "credit applied exactly once ($before_to -> $after_to)" \
    "$([ "$((after_to - before_to))" -eq "$amount" ] && echo 1 || echo 0)"
  check "no prepared transaction is left on shard A" "$([ "$(prepared_count A)" = "0" ] && echo 1 || echo 0)"
  check "no prepared transaction is left on shard B" "$([ "$(prepared_count B)" = "0" ] && echo 1 || echo 0)"
}

scenario B crash_after_prepare 17 A0800 A1800
scenario C crash_after_decision 19 A0800 A1800

say ""
say "recovery log excerpt:"
log_coordinator 20

finish_experiment
