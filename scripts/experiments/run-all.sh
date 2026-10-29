#!/usr/bin/env bash
# Run every experiment sequentially. Stops at the first failing experiment so a
# regression does not cascade into the following ones.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
status=0

for script in "$DIR"/0*-*.sh; do
  echo
  echo "##############################################################"
  echo "# $(basename "$script")"
  echo "##############################################################"
  if ! bash "$script"; then
    echo "experiment failed: $(basename "$script")"
    status=1
    break
  fi
done

if [ "$status" -eq 0 ]; then
  echo
  echo "all experiments passed"
fi
exit "$status"
