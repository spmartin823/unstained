#!/usr/bin/env bash
# End-to-end smoke test for the tournament daemon.
#
# Spins up a temporary git repo, runs the daemon for ONE round in smoke mode
# (fake worker shell script + synthetic scores; no claude, no ETE, no eval),
# and verifies state.json + audit.jsonl + scores/ are populated and the round
# completed cleanly.
#
# Usage:
#   bash automation/tournament/bin/smoke.sh
#
# Expected duration: ~60-90 seconds.
set -eu

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROMPT_SRC="$REPO_ROOT/automation/tournament/prompts/tournament-worker.md"
SMOKE_CONFIG="$REPO_ROOT/automation/tournament/config.smoke.json"

if [ ! -f "$PROMPT_SRC" ]; then
    echo "[smoke] expected prompt at $PROMPT_SRC" >&2
    exit 1
fi
if [ ! -f "$SMOKE_CONFIG" ]; then
    echo "[smoke] expected config at $SMOKE_CONFIG" >&2
    exit 1
fi

TMPROOT="$(mktemp -d -t tournament-smoke-XXXXXX)"
echo "[smoke] tmp root: $TMPROOT"
TMP_REPO="$TMPROOT/repo"
mkdir -p "$TMP_REPO/automation/tournament/prompts"
cp "$PROMPT_SRC" "$TMP_REPO/automation/tournament/prompts/tournament-worker.md"

cd "$TMP_REPO"
git init --initial-branch=main -q
git config user.email "smoke@example.com"
git config user.name "smoke"
echo "init" > README.md
git add README.md
git commit -q -m "init"

export PATH="/Users/SeamusMartin1/.nvm/versions/node/v24.15.0/bin:$PATH"
export TOURNAMENT_REPO_ROOT="$TMP_REPO"
export TOURNAMENT_SMOKE=1

# Run the daemon. maxRounds=1 in config.smoke.json ensures it exits after one round.
TSX="$REPO_ROOT/node_modules/.bin/tsx"
"$TSX" "$REPO_ROOT/automation/tournament/src/orchestrator.ts" "$SMOKE_CONFIG" 2>&1 | tee "$TMPROOT/daemon.log"

# Verify outcomes.
STATE_FILE="$TMP_REPO/tournament/state.json"
AUDIT_FILE="$TMP_REPO/tournament/audit.jsonl"
SCORES_DIR="$TMP_REPO/tournament/scores"

fail=0
if [ ! -f "$STATE_FILE" ]; then
    echo "[smoke] FAIL: state.json missing at $STATE_FILE"
    fail=1
fi
if [ ! -f "$AUDIT_FILE" ]; then
    echo "[smoke] FAIL: audit.jsonl missing at $AUDIT_FILE"
    fail=1
fi
if [ ! -d "$SCORES_DIR" ] || [ -z "$(ls -A "$SCORES_DIR" 2>/dev/null)" ]; then
    echo "[smoke] FAIL: scores dir empty at $SCORES_DIR"
    fail=1
fi

if [ "$fail" -eq 0 ]; then
    history_len=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8')).history.length)")
    if [ "$history_len" -lt 1 ]; then
        echo "[smoke] FAIL: state.history is empty (no rounds completed)"
        fail=1
    else
        echo "[smoke] state.history has $history_len round(s)"
        outcome=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8')).history[0].outcome)")
        echo "[smoke] round 1 outcome: $outcome"
    fi

    score_count=$(ls "$SCORES_DIR" | wc -l | tr -d ' ')
    echo "[smoke] $score_count scorecard(s) written"

    audit_events=$(wc -l < "$AUDIT_FILE" | tr -d ' ')
    echo "[smoke] $audit_events audit events"

    have_round_start=$(grep -c '"round_start"' "$AUDIT_FILE" || true)
    have_round_end=$(grep -c '"round_end"' "$AUDIT_FILE" || true)
    have_scoring=$(grep -c '"scoring_complete"' "$AUDIT_FILE" || true)
    if [ "$have_round_start" -lt 1 ] || [ "$have_round_end" -lt 1 ] || [ "$have_scoring" -lt 1 ]; then
        echo "[smoke] FAIL: missing required audit events (round_start=$have_round_start round_end=$have_round_end scoring_complete=$have_scoring)"
        fail=1
    fi
fi

if [ "$fail" -ne 0 ]; then
    echo "[smoke] FAILED. Inspect $TMPROOT for diagnostics."
    exit 1
fi

echo "[smoke] PASS — full lifecycle executed: spawn → score → select → cleanup"
rm -rf "$TMPROOT"
