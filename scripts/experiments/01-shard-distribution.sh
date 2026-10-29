#!/usr/bin/env bash
# Experiment 1: account -> shard routing (sharding key is the account id).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

start_experiment 01-shard-distribution
wait_gateway_ready

say ""
say "account  expected  observed  replica  balance"
say "-------  --------  --------  -------  -------"

accounts=(A0001 A0002 A0500 A0999 A1000 A1001 A1200 A1500 A1999 A2000)
for account in "${accounts[@]}"; do
  number=$((10#${account:1}))
  if [ "$number" -le 1000 ]; then
    expected="A"
  else
    expected="B"
  fi
  observed="$(shard_of "$account")"
  replica="$(replica_of "$account")"
  value="$(balance_or_fail "$account")"
  printf '%-7s  %-8s  %-8s  %-7s  %s\n' "$account" "$expected" "$observed" "$replica" "$value" |
    tee -a "$LOG_FILE"
  check "$account is owned by shard $expected" "$([ "$observed" = "$expected" ] && echo 1 || echo 0)"
done

say ""
say "shard map fingerprint:"
api "$GATEWAY/v1/status" | jq '{version: .shardMapVersion, fingerprint: .shardMapFingerprint, replicas: [.replicas[] | {shardId, replicaId, healthy}]}' |
  tee -a "$LOG_FILE"

finish_experiment
