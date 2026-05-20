/*
 * Daemon entry point for the Stainless→Fern migration tournament.
 *
 * This is a STUB. The pure functions in selection.ts and allowlist.ts are
 * implemented and tested; the loops below are scaffolding only.
 *
 * Run (once implemented):
 *   tsx automation/tournament/src/orchestrator.ts
 *
 * Or via launchd:
 *   launchctl load ~/Library/LaunchAgents/com.unstained.tournament.plist
 */

import { readFile } from "node:fs/promises";

import type { TournamentConfig } from "./types.js";

const ROUND_LOOP_INTERVAL_MS = 60_000;
const SCORING_LOOP_INTERVAL_MS = 30_000;

export async function loadConfig(path: string): Promise<TournamentConfig> {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as TournamentConfig;
}

export async function main(configPath: string): Promise<void> {
    const config = await loadConfig(configPath);
    // eslint-disable-next-line no-console
    console.log(
        `[tournament] daemon stub started (workers=${config.workersPerRound}, rounds=${config.roundDurationHours}h)`
    );

    // TODO(phase-2-impl): implement the round loop.
    // Pseudocode:
    //   while (!shouldStop) {
    //     const state = await readState();
    //     if (state.currentRound == null) {
    //       state.currentRound = await startRound(1, "main", config);
    //       await writeState(state);
    //     } else if (Date.now() >= Date.parse(state.currentRound.deadline)) {
    //       await terminateRoundWorkers(state.currentRound);
    //       const winner = selectWinner(scoresForBranches(state.currentRound), config.tieEpsilon);
    //       await applyWinner(winner, config);
    //       await cleanupRound(state.currentRound);
    //       state.history.push(roundOutcome(winner));
    //       state.currentRound = await startRound(state.currentRound.number + 1, "main", config);
    //       await writeState(state);
    //     }
    //     await sleep(ROUND_LOOP_INTERVAL_MS);
    //   }

    // TODO(phase-2-impl): implement the scoring loop.
    // Pseudocode:
    //   while (!shouldStop) {
    //     for (const worker of state.currentRound?.workers ?? []) {
    //       const sentinel = `${worker.worktree}/.tournament/scoreme`;
    //       if (await exists(sentinel)) {
    //         await unlink(sentinel);
    //         scoringQueue.enqueue({branch: worker.branch, sha: await headSha(worker.worktree)});
    //       }
    //     }
    //     await sleep(SCORING_LOOP_INTERVAL_MS);
    //   }

    // TODO(phase-2-impl): implement the scoring pool.
    // Pseudocode:
    //   while (!shouldStop) {
    //     const job = await scoringQueue.dequeue();
    //     const scorer = await acquireScorer();
    //     try {
    //       await git.checkout(scorer.worktree, job.sha);
    //       const eteResult = await runEte(scorer.worktree);
    //       if (eteResult === "fail") {
    //         await writeScore({sha: job.sha, branch: job.branch, ete: "fail", ...});
    //         continue;
    //       }
    //       const pairResults = await runEvalMatrix(scorer.worktree, config.fixtures, config.languages);
    //       await writeScore(aggregateScore(job, eteResult, pairResults));
    //     } finally {
    //       releaseScorer(scorer);
    //     }
    //   }

    // Use intervals to prevent unused-symbol lint and to document intent.
    void ROUND_LOOP_INTERVAL_MS;
    void SCORING_LOOP_INTERVAL_MS;
}

// CLI entrypoint, only when invoked directly via tsx.
if (process.argv[1] != null && process.argv[1].endsWith("orchestrator.ts")) {
    const configPath = process.argv[2] ?? "automation/tournament/config.json";
    main(configPath).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[tournament] daemon error:", err);
        process.exit(1);
    });
}
