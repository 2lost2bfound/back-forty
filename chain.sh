#!/usr/bin/env bash
# Usage: ./chain.sh [first milestone, default 1] — builds milestones in order through M11.
# Waits for any running build.sh to finish; a failed milestone gets one retry on Big Pickle, then the chain stops.
set -uo pipefail
cd "$(dirname "$0")"

while pgrep -f "build.sh [0-9]" >/dev/null; do echo ">>> waiting for running build to finish..."; sleep 30; done
if [ "${1:-1}" -gt 0 ]; then node --test tests/ || { echo ">>> previous milestone tests not green, not chaining"; exit 1; }; fi

for m in $(seq "${1:-1}" 11); do
  ./build.sh "$m" && continue
  echo ">>> M$m failed, retrying once on Big Pickle"
  MODEL_OVERRIDE=opencode/big-pickle ./build.sh "$m" && continue
  echo ">>> M$m still failing; chain stopped. Fix it, then: ./chain.sh $((m + 1))"
  exit 1
done
echo ">>> All milestones M${1:-1}-M11 built with green tests."
