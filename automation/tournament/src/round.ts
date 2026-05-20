/*
 * Round lifecycle: worktree create/destroy, worker subprocess spawn/terminate.
 *
 * STUB — function signatures only. Implementation in a follow-up PR.
 */

import type { RoundState, TournamentConfig, WorkerState } from "./types.js";

export interface StartRoundOptions {
    readonly roundNumber: number;
    readonly parentBranch: string;
    readonly config: TournamentConfig;
    readonly tournamentRoot: string;
    readonly worktreeRoot: string;
    readonly promptPath: string;
}

export interface CleanupRoundOptions {
    readonly round: RoundState;
    readonly winnerBranch: string | null;
    readonly worktreeRoot: string;
}

export async function startRound(_opts: StartRoundOptions): Promise<RoundState> {
    // TODO(phase-2-impl):
    //   1. For each worker 1..workersPerRound:
    //      a. `git worktree add -b tournament/r<NN>/w<MM> <worktreeRoot>/r<NN>-w<MM> <parentBranch>`
    //      b. Seed .context/tournament-worker.md from promptPath
    //      c. Seed .context/worker.env with ROUND, WORKER, DEADLINE, TOURNAMENT_ROOT
    //      d. mkdir -p .tournament/
    //      e. Spawn:
    //           timeout ${roundDurationHours}h claude --print \
    //             --append-system-prompt "$(cat .context/tournament-worker.md)" \
    //             --model opus-4-7 \
    //             "Round NN, worker MM. Begin."
    //         with PATH including Node 24 (per feedback memory), logging to <tournamentRoot>/logs/r<NN>-w<MM>.log
    //   2. Issue `caffeinate -di` for the round duration to keep the Mac awake.
    //   3. Return RoundState with deadline = now + roundDurationHours.
    throw new Error("startRound: not implemented (phase-2-impl)");
}

export async function terminateWorker(_worker: WorkerState): Promise<void> {
    // TODO(phase-2-impl): SIGTERM, wait 30s, then SIGKILL if still running.
    throw new Error("terminateWorker: not implemented (phase-2-impl)");
}

export async function cleanupRound(_opts: CleanupRoundOptions): Promise<void> {
    // TODO(phase-2-impl):
    //   For each branch in round.workers:
    //     git worktree remove --force <worktree>
    //     git branch -D <branch>
    //   (The winner's worktree + branch are also removed; the winning diff lives on main now.)
    throw new Error("cleanupRound: not implemented (phase-2-impl)");
}
