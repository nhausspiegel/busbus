#!/usr/bin/env bash
# Stop-hook test gate for busbus.
#
# Runs the app's test suite when Claude tries to end a turn. On failure it exits
# 2, which BLOCKS the stop and hands the failure text back to Claude to fix --
# no human approval needed, which is the point. On pass (or when there is
# nothing to run yet) it exits 0 and the turn ends normally.
#
# Two deliberate limits, both about not burning tokens:
#
#   1. ONE retry, not infinite. Claude Code sets stop_hook_active=true on the
#      re-entry after a block. We honor it and let the turn end, so a genuinely
#      stuck failure costs one extra attempt instead of looping until the
#      budget is gone. Claude still reports the failure in its reply.
#      ponytail: single retry; add an attempt-counter file if one proves too few.
#
#   2. Output is capped at MAX_LINES. A full vitest stack dump fed back every
#      turn is exactly the context bleed this project is trying to avoid.
#
# Deliberately does NOT run busbus.py: it hits the live Passio API and waits on
# the websocket for up to 40s. Running that on every turn would be slow and
# rude to someone else's server. Run it by hand -- see README.

set -uo pipefail

MAX_LINES=40
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

input=$(cat)

# Already blocked once this turn -> let it stop. Prevents an infinite loop.
if printf '%s' "$input" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

cd "$PROJECT_DIR" || exit 0

# Nothing to gate until the web app exists. Inert by design, not broken.
[ -f package.json ] || exit 0
command -v npm >/dev/null 2>&1 || exit 0
grep -q '"test"[[:space:]]*:' package.json || exit 0

output=$(npm test --silent 2>&1)
status=$?

[ $status -eq 0 ] && exit 0

{
  echo "BLOCKED: the test suite is failing, so this turn is not finished."
  echo
  echo "Last ${MAX_LINES} lines of \`npm test\`:"
  echo "---"
  printf '%s\n' "$output" | tail -n "$MAX_LINES"
  echo "---"
  echo
  echo "Fix the failing test, or explain why the failure is expected and correct"
  echo "the test itself. Do not delete or skip a test to make this pass."
} >&2

exit 2
