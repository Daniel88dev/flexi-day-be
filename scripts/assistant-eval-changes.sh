#!/usr/bin/env bash
# Prints run=true when the diff between two commits touches what the Assistant
# eval measures, run=false otherwise. The assistant-eval workflow reads it.
#   scripts/assistant-eval-changes.sh <base> <head>
set -euo pipefail

base=$1
head=$2
range="$base...$head"

# Prompts, tool definitions, the price table, the eval itself and the KB snapshot.
paths='^(src/services/assistant/(agent|screen)/|src/services/assistant/meter/prices\.ts$|src/tools/|src/evals/|src/tests/fixtures/kb-snapshot\.json$|vitest\.eval\.config\.ts$|scripts/assistant-eval-changes\.sh$|\.github/workflows/assistant-eval\.yml$)'

if git diff --name-only "$range" | grep -Eq "$paths"; then
  echo "run=true"
  exit 0
fi

# Model config lines in config.ts, and the Anthropic SDK's version.
changed_lines() {
  git diff --unified=0 "$range" -- "$@" | grep -E '^[+-][^+-]' || true
}
if changed_lines src/config.ts | grep -Eq 'ASSISTANT_(MODEL|EFFORT|SCREEN_MODEL)' ||
  changed_lines package.json pnpm-lock.yaml | grep -q '@anthropic-ai/sdk'; then
  echo "run=true"
  exit 0
fi

echo "run=false"
