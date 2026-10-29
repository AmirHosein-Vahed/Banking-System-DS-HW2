#!/usr/bin/env bash
# Shared helpers for the experiment scripts.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATEWAY="${GATEWAY:-http://localhost:8080}"
COMPOSE=(docker compose -f "$ROOT_DIR/deploy/compose.yaml")
TSX="$ROOT_DIR/node_modules/.bin/tsx"
ARTIFACT_ROOT="${ARTIFACT_ROOT:-$ROOT_DIR/artifacts}"
OUT_DIR=""
LOG_FILE=""
FAILURES=0

start_experiment() {
  local name="$1"
  OUT_DIR="$ARTIFACT_ROOT/$(date +%Y%m%dT%H%M%S)-$name"
  mkdir -p "$OUT_DIR"
  LOG_FILE="$OUT_DIR/experiment.log"
  : >"$LOG_FILE"
  say "=============================================================="
  say "experiment: $name"
  say "gateway:    $GATEWAY"
  say "artifacts:  $OUT_DIR"
  say "=============================================================="
}

say() {
  printf '%s\n' "$*" | tee -a "$LOG_FILE"
}

json() {
  # Pretty-print JSON and append it to the log.
  jq . | tee -a "$LOG_FILE"
}

check() {
  local description="$1"
  local condition="$2"
  if [ "$condition" = "1" ]; then
    say "PASS  $description"
  else
    say "FAIL  $description"
    FAILURES=$((FAILURES + 1))
  fi
}

finish_experiment() {
  if [ "$FAILURES" -ne 0 ]; then
    say "result: $FAILURES check(s) failed"
    exit 1
  fi
  say "result: all checks passed"
}

api() {
  curl -sS --max-time 30 "$@"
}

balance() {
  api "$GATEWAY/v1/accounts/$1/balance" | jq -r '.balance'
}

balance_or_fail() {
  local account="$1"
  local value
  value="$(balance "$account")"
  if [ -z "$value" ] || [ "$value" = "null" ]; then
    say "could not read balance of $account"
    exit 1
  fi
  printf '%s' "$value"
}

replica_of() {
  api -D - -o /dev/null "$GATEWAY/v1/accounts/$1/balance" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-replica-id"{print $2}'
}

shard_of() {
  api -D - -o /dev/null "$GATEWAY/v1/accounts/$1/balance" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-shard-id"{print $2}'
}

psql_coord() {
  "${COMPOSE[@]}" exec -T coordinator-db psql -U banking -d banking -tAc "$1"
}

psql_shard() {
  local shard="${1,,}"
  local sql="$2"
  "${COMPOSE[@]}" exec -T "shard-${shard}-db" psql -U banking -d banking -tAc "$sql"
}

shard_total() {
  psql_shard "$1" "select coalesce(sum(balance), 0) from accounts;"
}

prepared_count() {
  psql_shard "$1" "select count(*) from pg_prepared_xacts;"
}

service_id() {
  # --all is required: after a simulated crash the container is no longer
  # running but we still need its exit code and state.
  "${COMPOSE[@]}" ps --all --quiet "$1"
}

container_state() {
  local id
  id="$(service_id "$1")"
  if [ -z "$id" ]; then
    printf 'missing'
    return
  fi
  docker inspect --format '{{.State.Status}}' "$id"
}

wait_service_health() {
  local service="$1"
  local timeout="${2:-60}"
  local deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local id state
    id="$(service_id "$service")"
    if [ -n "$id" ]; then
      state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")"
      if [ "$state" = "healthy" ] || [ "$state" = "running" ]; then
        return 0
      fi
    fi
    sleep 1
  done
  say "timeout waiting for $service to become healthy"
  return 1
}

wait_gateway_ready() {
  local timeout="${1:-60}"
  local deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if api -o /dev/null -w '%{http_code}' "$GATEWAY/readyz" | grep -q '^200$'; then
      return 0
    fi
    sleep 1
  done
  say "gateway did not become ready within ${timeout}s"
  return 1
}

wait_tx_completed() {
  local tx_id="$1"
  local timeout="${2:-60}"
  local deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local body
    body="$(api "$GATEWAY/v1/transactions/$tx_id" || true)"
    if [ "$(printf '%s' "$body" | jq -r '.status // empty')" = "COMPLETED" ]; then
      printf '%s' "$body"
      return 0
    fi
    sleep 1
  done
  say "transaction $tx_id did not complete within ${timeout}s"
  return 1
}

restart_coordinator() {
  local faults="${1:-}"
  FAULTS="$faults" "${COMPOSE[@]}" up -d --force-recreate --no-deps coordinator >/dev/null
  wait_service_health coordinator 60
}

wait_coordinator_exit() {
  local timeout="${1:-30}"
  local deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(container_state coordinator)" = "exited" ]; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

log_coordinator() {
  "${COMPOSE[@]}" logs coordinator --no-log-prefix 2>&1 | tail -n "${1:-40}" | tee -a "$LOG_FILE"
}
