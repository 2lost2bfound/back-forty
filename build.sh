#!/usr/bin/env bash
# Usage: ./build.sh <milestone 0-11>   — builds one milestone of plan.md with the model picked for it.
set -euo pipefail
cd "$(dirname "$0")"

M="${1:?usage: ./build.sh <milestone number 0-11>}"
GLM=opencode/glm-5.3-flash-free        # rendering, UI, world, content-heavy milestones
DS=opencode/deepseek-v4.1-flash-free   # formula/sim/balance-heavy milestones
case "$M" in
  0|1|2|4|7|8|9) MODEL=$GLM ;;
  3|5|6|10|11)   MODEL=$DS ;;
  *) echo "milestone must be 0-11"; exit 1 ;;
esac
MODEL="${MODEL_OVERRIDE:-$MODEL}"   # e.g. MODEL_OVERRIDE=opencode/big-pickle ./build.sh 3

echo ">>> Milestone M$M with $MODEL"
opencode run -m "$MODEL" --auto --title "Back Forty M$M" \
  "Read plan.md. Build Milestone M$M only (the '### M$M —' section under DELIVERABLE 4 — BUILD ORDER), following every 'Rules for the builder' item and the architecture in DELIVERABLE 2. Earlier milestones are already built in this folder; extend them, do not rewrite them. When done, run 'node --test tests/' and fix failures until it is green. Do not start the next milestone. Finish with a short list of what is done and anything from the 'Done when' list you could not verify (e.g. the perf gate on the target machine)."

echo ">>> Checking tests"
node --test tests/ && echo ">>> M$M tests green" || { echo ">>> M$M tests FAILED — rerun with: MODEL_OVERRIDE=opencode/big-pickle ./build.sh $M"; exit 1; }
