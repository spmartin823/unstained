# Design: Stainless → Fern Migration Tournament (Phase 2)

**Status:** Draft, scaffolding stage. Not yet running unattended.
**Owner:** Seamus Martin (seamus@presspass.ai)
**Phase 1 dependency:** `stainless-equivalency-eval/` submodule, merge commit `6fdb4ab`.
**Date:** 2026-05-19.

## Context

Stainless was acquired by Anthropic and is being shut down. Customers (Anthropic, OpenAI, Luma, Honcho, Papr, Runloop, …) face SDK regeneration. This repo's commercial goal is to migrate Stainless customers to Fern by producing surface- and behaviorally-equivalent SDKs from their existing `openapi.yaml` + `openapi.stainless.yml` inputs.

Phase 1 shipped a deterministic eval (`stainless-equivalency-eval/`) that scores Fern's generator output against three Stainless reference SDKs (lumaai, papr, honcho) on five weighted metrics. Composite scorecards are produced per (fixture, language) pair — 6 pairs total.

Phase 2 (this document) is the **agentic migration loop** — a parallel-branch tournament where N Claude Code worker sessions edit Fern's generators on isolated branches and the eval is the fitness function. The highest-scoring branch per round auto-merges to `main` (subject to a path allowlist). Losing branches are deleted. Next round begins.

## Goal

A daemon-managed tournament that can run unattended overnight, producing measurable improvement on the Stainless equivalency eval without breaking Fern's existing 165 ETE fixtures and without leaking unreviewed generator changes into shippable `main`.

## Non-goals

- A web dashboard, live UI, or notifications.
- Cross-worker collaboration / shared scratch.
- Editing Phase 1's eval submodule. The eval is the judge; editing it is cheating.
- Running on cloud infrastructure (GitHub Actions, dedicated VMs). All-local on the user's Mac.
- Solving the "behavioral metric is null in early rounds" problem with a special Round 0. Workers will figure out behavioral-unlock under F-fitness pressure; the first round may be a wash.

## Architecture

Three components: a local daemon, N worker subprocesses, and a set of files on disk. No cloud, no daemons-talking-to-daemons, no shared state beyond the filesystem.

```
   ┌────────────────────────────────────────────────────────────────────┐
   │   Daemon (local Mac, Node + tsx, launchd-supervised)               │
   │                                                                    │
   │   State                                                            │
   │   - tournament/state.json   (current round, branches, PIDs)        │
   │   - tournament/scores/<sha>.json  (canonical per-SHA scorecards)   │
   │   - tournament/logs/r<NN>-w<MM>.log  (worker stdout/stderr)        │
   │   - tournament/audit.jsonl  (append-only event log)                │
   │                                                                    │
   │   Loops (single Node process, multiple async loops)                │
   │   - Round loop  (60s): on deadline, terminate workers, select,     │
   │     merge winner (or open PR), cleanup losers, start next round    │
   │   - Scoring loop  (30s): scan worktrees for .tournament/scoreme,   │
   │     enqueue (branch, HEAD) for scoring                             │
   │   - Scoring pool  (M=2 concurrent): each scorer owns a dedicated   │
   │     worktree under tournament/scoring/scorer-<N>; runs ETE then    │
   │     fans out 6 eval pairs (Docker semaphore-bounded), aggregates   │
   │     to tournament/scores/<sha>.json                                │
   └────────────────────┬───────────────────────────────────────────────┘
                        │  spawns / kills
                        ▼
   ┌────────────────────────────────────────────────────────────────────┐
   │   N=3 worker worktrees: tournament/r<NN>-w<MM>/                    │
   │                                                                    │
   │   git worktree add -b tournament/r<NN>/w<MM> <path> main           │
   │   .context/tournament-worker.md   ← worker prompt (daemon-seeded)  │
   │   .context/worker.env             ← ROUND, WORKER, DEADLINE        │
   │                                                                    │
   │   Subprocess:                                                      │
   │     timeout ${ROUND_HOURS}h claude --print                         │
   │       --append-system-prompt "$(cat .context/tournament-worker.md)"│
   │       --model opus-4-7                                             │
   │       "Round NN, worker MM. Begin." > $LOG 2>&1                    │
   │                                                                    │
   │   Worker writes:                                                   │
   │     - normal commits on its branch                                 │
   │     - .tournament/scoreme  (sentinel; daemon consumes and deletes) │
   │   Worker reads (after daemon scores):                              │
   │     - .tournament/score.json   (daemon-owned)                      │
   └────────────────────────────────────────────────────────────────────┘
```

### Key design choices

1. **Worker requests scoring; daemon owns scoring.** Worker writes `.tournament/scoreme` (empty sentinel) after a commit. Daemon picks it up in ≤30s, scores in a dedicated scorer worktree (separate from the worker's working dir, no race), writes canonical scorecard to `tournament/scores/<sha>.json`, copies it to the worker's `.tournament/score.json`.
2. **Scoring pool M=2.** Two concurrent scorers handle 3 workers' checkpoint requests without falling behind. Docker semaphore caps concurrent Fern generator runs at 2 globally.
3. **N=3 workers, 2-hour rounds, 15-minute grace.** Overnight (9 hours) → ~4 rounds. Configurable in `automation/tournament/config.json`.
4. **Stale-commit drop.** Daemon scores only the latest enqueued SHA per branch.
5. **Launchd-supervised daemon.** Survives reboots; restarts on crash; resumes from `state.json`.
6. **Caffeinate.** Daemon issues `caffeinate -di` for the duration of each round.
7. **No remote pushes from workers.** Branches stay local. The daemon's selection step does `git push origin main` after a successful merge if `config.push_main` is true. Losing branches are deleted locally.

## Fitness function

Lexicographic on the eval's composite scorecard. Six (fixture × language) pairs:

- `lumaai-typescript`, `lumaai-python`
- `papr-typescript`, `papr-python`
- `honcho-typescript`, `honcho-python`

```
Tier 1: behavioral mean across all 6 pairs, with null → 0 for fitness purposes.
Tier 2: only if Tier 1 is tied within ε = 0.005. Mean of the four non-behavioral
        metrics, re-normalized to sum to 1:
            sig × 0.5 + sym × 0.3 + file × 0.1 + struct × 0.1
Tier 3: scored_at timestamp (earliest scored commit wins). Deterministic
        tie-break.
```

### Why null → 0 (and not "null = excluded")

The eval's *composite* metric uses null-skipping renormalization. For *fitness*, we treat null as 0. Reason: a branch that achieves null on 5 pairs and 1.0 on one pair would otherwise dominate. Null-as-zero pushes workers to *unlock* behavioral across pairs, which is exactly the work we want done.

### Why lexicographic (and not weighted sum)

Behavioral is the only metric that measures "the generated SDK actually works." The other four measure surface mimicry. We don't want a worker winning on prettier-looking generated code that doesn't run; we want the worker that unlocks behavioral non-null even by one pair. Lexicographic enforces this priority absolutely.

## Selection algorithm

Run at round deadline.

```
candidates = []
for branch in round.branches:
  sha = git rev-parse <branch>
  score = read("tournament/scores/<sha>.json")
  if !score or score.ete == "fail" or score.guard_violation:
    log_dq(branch, reason); continue
  candidates.push({branch, sha, score})

if candidates.empty: log("no winner"); return                    # main unchanged

# Tier 1: behavioral mean, null → 0
for c in candidates:
  c.t1 = mean(c.score.behavioral_values.map(v => v ?? 0))
candidates.sort(by t1 desc)
top_t1 = candidates[0].t1
tier1 = candidates.filter(c => c.t1 >= top_t1 - 0.005)
if tier1.length == 1: return tier1[0]

# Tier 2: re-normalized non-behavioral composite
for c in tier1:
  c.t2 = c.score.signature_mean * 0.5 +
         c.score.symbol_mean    * 0.3 +
         c.score.file_mean      * 0.1 +
         c.score.structural_mean * 0.1
tier1.sort(by t2 desc)
top_t2 = tier1[0].t2
tier2 = tier1.filter(c => c.t2 >= top_t2 - 0.005)
if tier2.length == 1: return tier2[0]

# Tier 3: deterministic timestamp
return tier2.sort(by scored_at asc)[0]
```

Implementation in `automation/tournament/src/selection.ts`. Unit-tested in `automation/tournament/__tests__/selection.test.ts`.

## Path allowlist

Diff between `main` and the winning branch's HEAD is checked against a glob allowlist. If all changed paths match the allowlist, auto-merge. Otherwise the daemon opens a PR for human review instead.

```
default allowlist:
  generators/typescript/**
  generators/python/**
  packages/ir-sdk/fern/apis/ir-types-latest/**     (per Fern IR Versioning rules)
  packages/ir-sdk/src/**                            (regenerated output from pnpm ir:generate)
  packages/generator-migrations/src/generators/typescript/**
  packages/generator-migrations/src/generators/python/**
  pnpm-lock.yaml
  tournament/notes/**                               (worker scratch notes)
```

Implementation in `automation/tournament/src/allowlist.ts`. Unit-tested in `automation/tournament/__tests__/allowlist.test.ts`.

### Guard violation: hard disqualification

Independent of fitness or allowlist: any commit that touches `stainless-equivalency-eval/` (the eval submodule's gitlink or contents) is detected by the scorer and flagged in `tournament/scores/<sha>.json` with `guard_violation: "edited stainless-equivalency-eval/..."`. Such branches are DQ'd at selection regardless of any other score.

## Worker prompt

Lives at `automation/tournament/prompts/tournament-worker.md`. Layered on top of Fern's repo `CLAUDE.md` (which Claude Code loads automatically). Covers:

1. **Who you are** — round/worker ID, deadline source, competing against N-1 unseen others.
2. **What you're optimizing** — explicit F-fitness explanation, behavioral-unlock as primary lever.
3. **Hard constraints** — never edit eval submodule; never break ETE; no `--no-verify`; no remote push; no subagent spawning.
4. **Path allowlist** — what auto-merges vs. what becomes a PR.
5. **Scoring protocol** — `.tournament/scoreme` → daemon → `.tournament/score.json` read-only contract; cheap local checks (`pnpm compile`) before requesting full scoring.
6. **Strategic guidance** — read the eval source, leverage order (behavioral → signature → others), opt-in flag policy non-negotiable, revert freely, don't game the eval.
7. **Required reading** — explicit reading list before any edits.
8. **Endgame** — when ≤15 min remain, stop new experiments, ensure final SHA is scored, document blockers for future workers.

## Data contracts

### `automation/tournament/config.json`
Hand-edited by the user; read by the daemon at startup and on round transitions.

```json
{
  "round_duration_hours": 2,
  "grace_minutes": 15,
  "workers_per_round": 3,
  "scorers": 2,
  "docker_concurrency": 2,
  "tie_epsilon": 0.005,
  "push_main": false,
  "languages": ["typescript", "python"],
  "fixtures": ["lumaai", "papr", "honcho"],
  "path_allowlist": [
    "generators/typescript/**",
    "generators/python/**",
    "packages/ir-sdk/fern/apis/ir-types-latest/**",
    "packages/ir-sdk/src/**",
    "packages/generator-migrations/src/generators/typescript/**",
    "packages/generator-migrations/src/generators/python/**",
    "pnpm-lock.yaml",
    "tournament/notes/**"
  ]
}
```

### `tournament/state.json`
Daemon-owned; atomic-rewritten on every event.

```json
{
  "tournament_id": "2026-05-19T22:00:00Z",
  "current_round": {
    "number": 3,
    "started_at": "...",
    "deadline": "...",
    "workers": [
      {
        "id": "w01",
        "branch": "tournament/r03/w01",
        "worktree": "/abs/path/to/r03-w01",
        "pid": 12345,
        "log": "tournament/logs/r03-w01.log",
        "started_at": "..."
      }
    ]
  },
  "history": [
    {
      "round": 1,
      "winner": {"branch": "tournament/r01/w02", "sha": "abc123", "t1": 0, "t2": 0.42},
      "outcome": "merged" | "pr" | "no_winner",
      "completed_at": "..."
    }
  ]
}
```

### `tournament/scores/<sha>.json`
Canonical scorecard. Written atomically (temp file + rename) by the scoring pool.

```json
{
  "sha": "abc123",
  "branch": "tournament/r03/w01",
  "scored_at": "2026-05-20T02:15:00Z",
  "ete": "pass" | "fail",
  "guard_violation": null | "edited stainless-equivalency-eval/...",
  "pairs": {
    "lumaai-typescript": { "...full eval scorecard..." },
    "lumaai-python":     { "..." },
    "papr-typescript":   { "..." },
    "papr-python":       { "..." },
    "honcho-typescript": { "..." },
    "honcho-python":     { "..." }
  },
  "aggregates": {
    "behavioral_values":  [0.5, null, 0.4, null, 0.2, null],
    "behavioral_mean":    0.234,
    "signature_mean":     0.78,
    "symbol_mean":        0.91,
    "file_mean":          0.85,
    "structural_mean":    0.88,
    "t1":                 0.234,
    "t2":                 0.77
  }
}
```

### `tournament/audit.jsonl`
Append-only, one event per line, never rewritten. The morning audit trail.

Event types:
- `round_start`, `round_end`
- `worker_spawned`, `worker_exit`
- `scoreme_received`, `scored`, `score_dq`
- `selection` (with reason: "single tier 1 winner" | "tier 2 tiebreak" | "tier 3 timestamp" | "no candidates")
- `merge`, `pr_opened`
- `cleanup`
- `daemon_start`, `daemon_restart`

### Per-worktree files

| Path | Owner | Description |
|------|-------|-------------|
| `.context/tournament-worker.md` | daemon | The worker prompt, copied from `automation/tournament/prompts/`. |
| `.context/worker.env` | daemon | `ROUND`, `WORKER`, `DEADLINE`, `TOURNAMENT_ROOT`. |
| `.tournament/scoreme` | worker (creates) → daemon (consumes + deletes) | Sentinel file. |
| `.tournament/score.json` | daemon | Copy of `tournament/scores/<HEAD>.json` for worker convenience. |

## Hard constraints (recap, single source of truth)

1. **No edits to `stainless-equivalency-eval/`** — enforced by guard violation check; DQ at scoring.
2. **No regressions on `test-definitions/`'s 165 fixtures** — enforced by `pnpm test:ete` as part of scoring. Failed ETE → `{ete: "fail"}` → DQ at selection.
3. **All generator default changes must be gated behind opt-in config flags** — per Fern's Breaking Changes Policy (`CLAUDE.md`). Worker prompt enforces; spot-checked by user on PR review for out-of-allowlist diffs.
4. **No hook bypassing** — `--no-verify`, `--no-gpg-sign`, etc. forbidden. Worker prompt enforces.
5. **No worker pushes to remote.** Daemon owns merging.
6. **Node 24 on PATH** — per saved feedback memory. Daemon prefixes PATH for all worker subprocesses.

## Edge case handling

| Case | Daemon behavior |
|------|-----------------|
| All workers DQ'd (no scores or all `ete: fail`) | `main` unchanged; next round branches from same `main` |
| All workers tie at tier 1 (likely Round 1) | Tier 2 decides; logged as `selection.reason: "all-tier-1-zero"` |
| Worker DQ via guard violation | Branch flagged in audit log; round continues with remaining workers |
| Worker's last commit isn't compileable | Daemon scores HEAD only; worker should `git revert` and re-scoreme |
| Daemon crashes mid-scoring | launchd restarts; state.json recovery: in-flight scorer worktree gets `git reset --hard`; scoreme is re-enqueued from worktree state |
| Round overruns due to slow scoring | Round deadline is hard; workers killed at `+round_duration`. Scoring continues up to `grace_minutes`. Selection waits up to that bound. |
| Mac sleeps mid-round | `caffeinate -di` issued at round start, killed at round end. Lid-close override → on wake, launchd resumes daemon, daemon reads state, continues. |
| `pnpm` invocation hits Node-20 path | Daemon prefixes `PATH=/Users/.../v24.15.0/bin:$PATH` for all spawned shells. |

## Initial scaffolding (this PR)

**Fully implemented, unit-tested:**
- `automation/tournament/src/selection.ts` — F-fitness ranking. Pure function.
- `automation/tournament/src/allowlist.ts` — Glob-matched path check. Pure function.
- `automation/tournament/src/types.ts` — shared types (Config, State, Score, Round, Worker).
- `automation/tournament/__tests__/selection.test.ts` — 6+ scenarios.
- `automation/tournament/__tests__/allowlist.test.ts` — allow/deny scenarios.

**Stubbed (signatures + types + TODO markers):**
- `automation/tournament/src/orchestrator.ts` — daemon entry; main async function with the three loops outlined but not implemented.
- `automation/tournament/src/round.ts` — `startRound()`, `cleanupRound()`.
- `automation/tournament/src/scoring.ts` — `runEte()`, `runEvalMatrix()`, `aggregate()`.

**Configuration + scaffolding files:**
- `automation/tournament/config.json` — defaults from above.
- `automation/tournament/package.json` — workspace member `@fern-api/tournament` with vitest, tsx, minimatch deps.
- `automation/tournament/tsconfig.json` — strict TS.
- `automation/tournament/vitest.config.ts` — vitest setup.
- `automation/tournament/README.md` — how to run; how to stop; where logs live.
- `automation/tournament/.gitignore` — ignore runtime state.
- `automation/tournament/launchd/com.unstained.tournament.plist` — reference plist (commented, not installed by this PR).
- `automation/tournament/prompts/tournament-worker.md` — the worker prompt.

**Not in this PR (deferred to follow-ups):**
- Daemon's worker spawning, scoring fan-out, file watching, atomic writes, launchd installation script.
- Round 0 / behavioral-unlock specialist workflow (intentionally skipped — workers figure this out under F pressure).
- Cross-worker visibility, web UI, notifications.

## Verification path (before flipping the daemon on)

1. **Selection unit tests pass.** Six scenarios: all-tied tier 1, clear tier 1 winner, tier 1 ε-tied, tier 1 all-zero, ETE-fail DQ, guard-violation DQ.
2. **Allowlist unit tests pass.** Diff path lists → correct auto-merge vs PR decision.
3. **Single-worker dry run** (not in this PR; follow-up). N=1 worker, 15-min round, validates: worktree creation, prompt loading, scoreme → score.json roundtrip.
4. **Single-pair eval dry run** (not in this PR; follow-up). Score one (fixture, language) for `main`'s current SHA. Validates per-pair runtime and scorecard schema.

Only after all four pass do we run a real overnight tournament.

## Open empirical questions (deferred until we have data)

1. Can a single `claude --print` session sustain 2h of autonomous coding without hitting per-session token caps? *Mitigation: start with 90-min rounds and double the round count.*
2. What does the scoring queue depth look like with N=3 workers committing every 5–10 min? *Sets the M scorers and Docker concurrency cap.*
3. Does Fern's seed Docker runner have issues with concurrent invocations across scorer worktrees? *Spot-test in a dry run.*
4. How often does behavioral=null actually fail to unlock in Round 1? *If every Round 1 ends with all-zero tier 1, add a manual warm-up exercise — not as a tournament round, as a focused session that produces the first behavioral-unlock seed for `main`.*
5. What time-of-day to run? *Thermal + cost-of-waking considerations. User will tune.*

## Related artifacts

- Phase 1 plan: `/Users/SeamusMartin1/.claude/plans/system-instruction-you-are-working-humble-lighthouse.md`
- Eval submodule: `github.com/spmartin823/stainless-equivalency-eval` (private)
- Parent Fern fork: `github.com/spmartin823/unstained` (public)
- Reference workspace: `/Users/SeamusMartin1/conductor/workspaces/unstained/barcelona`
