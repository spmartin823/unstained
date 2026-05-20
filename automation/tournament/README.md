# tournament — Stainless→Fern migration loop

A daemon that runs the Phase 2 agentic migration loop. Workers are headless `claude --print` sessions on git worktrees; the eval submodule is the fitness function; winners auto-merge to `main` (or open a PR if the diff exits a path allowlist).

For the full design, see [DESIGN.md](./DESIGN.md).

## Status

**Daemon implemented and end-to-end smoke-tested.** Has not yet run a real overnight tournament. Before kicking one off, run `pnpm preflight` and the smoke harness.

## Quick reference

```bash
# 1. Type-check + unit tests
pnpm --filter @fern-api/tournament compile
pnpm --filter @fern-api/tournament test

# 2. Pre-flight: validates the environment without running anything
pnpm --filter @fern-api/tournament preflight

# 3. Smoke test: full lifecycle in a temp repo, ~60s, no claude/eval
bash automation/tournament/bin/smoke.sh

# 4. Real run, foreground (Ctrl-C to stop gracefully):
pnpm --filter @fern-api/tournament start

# 5. Real run, supervised by launchd (recommended for overnight):
#    Edit launchd/com.unstained.tournament.plist to fix paths, then:
cp automation/tournament/launchd/com.unstained.tournament.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.unstained.tournament.plist

# Stop:
launchctl unload ~/Library/LaunchAgents/com.unstained.tournament.plist
```

## What the daemon does

Each round, the daemon:

1. Creates N git worktrees, one per worker, branched from `main`.
2. Seeds `.context/tournament-worker.md` (the prompt) and `.context/worker.env` (round/worker/deadline) in each worktree.
3. Spawns `claude --print --model claude-opus-4-7 --max-budget-usd <BUDGET> --dangerously-skip-permissions --append-system-prompt <prompt>` in each worktree.
4. Workers commit changes; when ready for scoring, they `touch .tournament/scoreme`.
5. The daemon's scoring loop sees the sentinel, runs `pnpm test:ete` then the 6-pair eval matrix in a dedicated scorer worktree (Docker semaphore-bounded), and writes `tournament/scores/<sha>.json`.
6. At the round deadline, workers are SIGTERMed (then SIGKILLed after 30s).
7. Selection: F-fitness picks the winner (tier 1: behavioral mean, tier 2: re-normalized non-behavioral composite, tier 3: timestamp).
8. Apply: if the winning diff stays inside the path allowlist, auto-merge to `main`. Otherwise push the branch and open a PR for review.
9. Cleanup: remove all worker worktrees and branches.
10. Next round starts from the new `main`.

The daemon also runs `caffeinate -di` to prevent Mac sleep during a round, persists state in `tournament/state.json`, appends events to `tournament/audit.jsonl`, recovers from interrupted rounds on restart, and halts after 3 consecutive failures.

## Configuration

`config.json` at the package root:

```jsonc
{
  "roundDurationHours": 2,        // wall-clock per round
  "graceMinutes": 15,             // post-deadline scoring drain window
  "workersPerRound": 3,           // N parallel workers
  "scorers": 2,                   // M concurrent scorer worktrees
  "dockerConcurrency": 2,         // max parallel Fern generator runs
  "tieEpsilon": 0.005,            // F-fitness tier-band tolerance
  "pushMain": false,              // if true, daemon pushes merged main to origin
  "languages": ["typescript", "python"],
  "fixtures": ["lumaai", "papr", "honcho"],
  "pathAllowlist": [
    "generators/typescript/**",
    "generators/python/**",
    "packages/ir-sdk/fern/apis/ir-types-latest/**",
    "packages/ir-sdk/src/**",
    "packages/generator-migrations/src/generators/typescript/**",
    "packages/generator-migrations/src/generators/python/**",
    "pnpm-lock.yaml",
    "tournament/notes/**"
  ],
  "workerBudgetUsd": 30,          // per-worker per-round Claude API budget
  "workerModel": "claude-opus-4-7",
  "parentBranch": "main",
  "roundLoopIntervalMs": 60000,
  "scoringPollIntervalMs": 30000,
  "maxRounds": null               // null = infinite; integer = stop after N
}
```

Per-night cost estimate: `workersPerRound × maxRounds × workerBudgetUsd` is the upper bound. With defaults (3 × 4 × $30) the daemon is bounded at $360/night even in the worst case.

## Runtime layout

```
tournament/                                  ← git-ignored at repo root
├── state.json                               ← current round, history, PIDs
├── audit.jsonl                              ← append-only event log
├── scores/<sha>.json                        ← canonical scorecards per scored commit
├── logs/r<NN>-w<MM>.log                     ← worker stdout/stderr
└── scoring/scorer-<N>/                      ← daemon-owned scoring worktrees

<repo>/../tournament-worktrees/r<NN>-w<MM>/  ← worker worktrees (outside repo)
```

Worker worktrees contain:

- `.context/tournament-worker.md` — the worker prompt
- `.context/worker.env` — ROUND, WORKER, DEADLINE, TOURNAMENT_ROOT
- `.tournament/scoreme` — sentinel created by worker, consumed by daemon
- `.tournament/score.json` — read-only score snapshot for the worker

## Hard constraints (enforced)

- Workers cannot edit `stainless-equivalency-eval/`. Detected at scoring time via `git diff --name-only`; flagged as `guardViolation` in the scorecard; disqualified at selection.
- ETE failure (`pnpm test:ete`) disqualifies the SHA regardless of eval score.
- Worker pushes to remote are not performed by the daemon (workers commit locally only).
- Out-of-allowlist winning diffs produce a PR instead of an auto-merge.

## Smoke test

`bin/smoke.sh` runs the daemon end-to-end in a temp git repo with `TOURNAMENT_SMOKE=1`:

- Worker is a tiny bash script that touches a file in `tournament/notes/`, commits, and touches `.tournament/scoreme`.
- Scoring returns synthetic deterministic scores (no claude, no ETE, no eval matrix).
- Verifies the daemon spawns workers, scores commits, picks a winner, merges, cleans up, and exits after the configured `maxRounds`.

This validates orchestration end-to-end in ~60 seconds without burning Claude budget or Docker time.

## Stopping a tournament

`launchctl unload …` or SIGTERM the foreground daemon. The daemon will:

1. Set `shouldStop = true`.
2. Finish the current round (or abort it if you SIGTERM hard).
3. Persist final state to `state.json`.
4. Stop caffeinate.

If the daemon is killed mid-round, the next start recovers: it sees `currentRound != null` in `state.json`, cleans up the abandoned round's branches/worktrees, records the round as `no_winner` in history, and proceeds to the next round.

To wipe state entirely:

```bash
launchctl unload ~/Library/LaunchAgents/com.unstained.tournament.plist 2>/dev/null || true
git worktree list | grep tournament/ | awk '{print $1}' | xargs -n1 git worktree remove --force 2>/dev/null
git branch | grep '^  tournament/' | xargs -n1 git branch -D 2>/dev/null
rm -rf tournament/{state.json,audit.jsonl,scores,logs,scoring}
```

## Audit log

`tournament/audit.jsonl` is one JSON line per event. Event types:

- `daemon_start`, `daemon_stop`
- `round_start`, `round_end`
- `worker_spawned`, `worker_exit`
- `scoreme_received`, `scoring_start`, `scoring_complete`, `score_dq`
- `selection` (with `reason` and `winner`)
- `merge`, `pr_opened`
- `cleanup`
- `error`

Read it with `jq` for diagnostics:

```bash
jq -c 'select(.ev == "error")' tournament/audit.jsonl
jq -c 'select(.ev == "selection")' tournament/audit.jsonl
```
