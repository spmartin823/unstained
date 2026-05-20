# tournament — Stainless→Fern migration loop

Scaffolding for the Phase 2 agentic migration tournament. **Not yet runnable end-to-end.** The pure ranking + path-allowlist logic is implemented and tested; the daemon, worker spawning, and scoring fan-out are stubbed.

For the full design, see [DESIGN.md](./DESIGN.md).

## What works today

- `src/selection.ts` — F-fitness winner selection over scorecards.
- `src/allowlist.ts` — Path-allowlist check for merge-vs-PR decision.
- `src/types.ts` — Shared types for Config, Score, State.
- `__tests__/selection.test.ts` — 9 scenarios.
- `__tests__/allowlist.test.ts` — 16 scenarios.

Run tests:

```bash
pnpm --filter @fern-api/tournament test
```

Type-check:

```bash
pnpm --filter @fern-api/tournament compile
```

## What's stubbed (next PRs)

- `src/orchestrator.ts` — daemon entry. Has the three loops (round, scoring, scoring pool) shaped as `// TODO` markers.
- `src/round.ts` — worktree create/destroy + worker spawn.
- `src/scoring.ts` — ETE + eval matrix fan-out, atomic score writes.

## Runtime layout (created by the daemon at startup)

```
tournament/                       ← git-ignored except this README + config.json + .gitignore
├── state.json                    ← current round, worker PIDs, history
├── audit.jsonl                   ← append-only event log
├── scores/<sha>.json             ← canonical scorecards per scored commit
├── logs/r<NN>-w<MM>.log          ← worker stdout/stderr
├── scoring/scorer-<N>/           ← daemon-owned scoring worktrees
└── r<NN>-w<MM>/                  ← worker worktrees (one per worker per round)
```

Worker worktrees contain seed files in `.context/`:

- `.context/tournament-worker.md` — the worker prompt (copy of `automation/tournament/prompts/tournament-worker.md`).
- `.context/worker.env` — `ROUND`, `WORKER`, `DEADLINE`, `TOURNAMENT_ROOT`.

Worker–daemon protocol via `.tournament/`:

- Worker writes `.tournament/scoreme` (empty sentinel) to request scoring.
- Daemon writes `.tournament/score.json` after scoring (read-only for worker).

## Running the daemon (future)

```bash
# Start: launchd-supervised (recommended for overnight)
launchctl load ~/Library/LaunchAgents/com.unstained.tournament.plist

# Or, foreground (for debugging):
pnpm --filter @fern-api/tournament exec tsx src/orchestrator.ts

# Stop:
launchctl unload ~/Library/LaunchAgents/com.unstained.tournament.plist
```

`launchd/com.unstained.tournament.plist` is a reference template — install it to `~/Library/LaunchAgents/` after editing the paths to match your environment.

## Configuration

Edit `config.json`. Defaults:

- 3 workers per round
- 2-hour rounds with 15-minute scoring grace
- 2 concurrent scorers, Docker concurrency cap 2
- Tie epsilon 0.005
- `pushMain: false` — winning merges stay local until you explicitly push

## Hard constraints (enforced)

- Workers cannot edit `stainless-equivalency-eval/`. Detected at scoring time; flagged as `guardViolation`; DQ'd at selection.
- ETE failure (`pnpm test:ete`) disqualifies a SHA regardless of eval score.
- Worker pushes to remote are blocked by convention (the worker prompt forbids it; the daemon doesn't push worker branches).
- Out-of-allowlist diffs produce a PR instead of a merge.

## Stopping a tournament

`launchctl unload …` halts the daemon. In-flight worker subprocesses keep running until they hit their `timeout` deadline; their commits remain on their branches. To wipe state and start over:

```bash
launchctl unload ~/Library/LaunchAgents/com.unstained.tournament.plist
git worktree list | grep tournament/ | awk '{print $1}' | xargs -n1 git worktree remove --force
git branch | grep '^  tournament/' | xargs git branch -D
rm -rf tournament/{state.json,audit.jsonl,scores,logs,scoring,r*}
```
