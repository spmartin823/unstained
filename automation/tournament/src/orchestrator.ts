/*
 * Daemon entry point for the Stainless-to-Fern migration tournament.
 *
 * Invocation:
 *   tsx automation/tournament/src/orchestrator.ts [configPath]
 *
 * Or via launchd: see automation/tournament/launchd/com.unstained.tournament.plist
 */

import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { ensureDir, fileExists, readJsonOrNull, writeJsonAtomic } from "./atomic-fs.js";
import { Auditor } from "./audit.js";
import { loadConfig } from "./config.js";
import { sleep } from "./concurrency.js";
import { revParse } from "./git.js";
import { resolvePaths } from "./paths.js";
import { cleanupRound, type SpawnedWorker, startRound, terminateWorker } from "./round.js";
import { ScoringPool, type ScoringJob } from "./scoring.js";
import { applyWinner, decideRound } from "./select-and-merge.js";
import type {
    RoundOutcome,
    TournamentConfig,
    TournamentPaths,
    TournamentState,
    WorkerState
} from "./types.js";

interface DaemonState {
    shouldStop: boolean;
    activeRound: {
        spawned: SpawnedWorker[];
    } | null;
}

class Daemon {
    private readonly auditor: Auditor;
    private readonly pool: ScoringPool;
    private readonly state: DaemonState = { shouldStop: false, activeRound: null };
    private caffeinate: ReturnType<typeof spawn> | null = null;
    private readonly scoredShas = new Set<string>();
    private readonly inFlightScores = new Set<string>();
    private readonly exitedWorkers = new Set<number>();

    constructor(
        private readonly config: TournamentConfig,
        private readonly paths: TournamentPaths
    ) {
        this.auditor = new Auditor(paths.auditFile);
        this.pool = new ScoringPool({ config, paths, auditor: this.auditor });
    }

    async run(): Promise<void> {
        await ensureDir(this.paths.runtimeRoot);
        await ensureDir(this.paths.scoresDir);
        await ensureDir(this.paths.logsDir);
        await ensureDir(this.paths.worktreeRoot);
        await this.auditor.log("daemon_start", {
            pid: process.pid,
            config: {
                rounds: this.config.roundDurationHours,
                workers: this.config.workersPerRound,
                scorers: this.config.scorers,
                model: this.config.workerModel,
                budget: this.config.workerBudgetUsd
            }
        });
        this.installSignalHandlers();
        this.startCaffeinate();

        let state: TournamentState = await this.recoverOrInit();
        let consecutiveFailures = 0;
        const MAX_CONSECUTIVE_FAILURES = 3;

        while (!this.state.shouldStop) {
            if (
                this.config.maxRounds != null &&
                state.history.length >= this.config.maxRounds
            ) {
                console.log(`[tournament] max rounds reached (${this.config.maxRounds}); exiting`);
                break;
            }
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                await this.auditor.log("error", {
                    where: "main_loop",
                    message: `${MAX_CONSECUTIVE_FAILURES} consecutive round failures; halting daemon`
                });
                console.error(
                    `[tournament] ${MAX_CONSECUTIVE_FAILURES} consecutive round failures; stopping`
                );
                break;
            }
            const roundNumber = state.history.length + 1;
            try {
                state = await this.runOneRound(state, roundNumber);
                consecutiveFailures = 0;
            } catch (err) {
                consecutiveFailures += 1;
                await this.auditor.log("error", {
                    where: "runOneRound",
                    round: roundNumber,
                    message: (err as Error).message,
                    consecutiveFailures
                });
                console.error(`[tournament] round ${roundNumber} failed:`, err);
                // Best-effort cleanup of any partial round state.
                await this.bestEffortCleanupForRound(roundNumber);
                const failedOutcome: RoundOutcome = {
                    round: roundNumber,
                    winner: null,
                    outcome: "no_winner",
                    completedAt: new Date().toISOString()
                };
                state = {
                    ...state,
                    currentRound: null,
                    history: [...state.history, failedOutcome]
                };
                await this.writeState(state);
                // Brief backoff before retrying so we don't hot-loop on persistent failures.
                await sleep(Math.min(30_000, 5000 * consecutiveFailures)).catch(() => {});
            }
        }

        this.stopCaffeinate();
        await this.auditor.log("daemon_stop", { reason: "shouldStop" });
    }

    private async recoverOrInit(): Promise<TournamentState> {
        const existing = await this.loadState();
        if (existing == null) {
            return {
                tournamentId: new Date().toISOString(),
                currentRound: null,
                history: []
            };
        }
        // If state.json shows a currentRound, the previous daemon was killed mid-round.
        // The worker processes are dead; their branches may exist; their scores may or may not.
        // We treat the round as a "no_winner" outcome, clean up its branches, and move on.
        if (existing.currentRound != null) {
            await this.auditor.log("daemon_start", {
                recovery: true,
                interrupted_round: existing.currentRound.number,
                workers: existing.currentRound.workers.map((w) => w.id)
            });
            try {
                await cleanupRound(
                    { config: this.config, paths: this.paths, auditor: this.auditor },
                    existing.currentRound
                );
            } catch (err) {
                await this.auditor.log("error", {
                    where: "recoverOrInit:cleanupRound",
                    message: (err as Error).message
                });
            }
            const recovered: TournamentState = {
                ...existing,
                currentRound: null,
                history: [
                    ...existing.history,
                    {
                        round: existing.currentRound.number,
                        winner: null,
                        outcome: "no_winner",
                        completedAt: new Date().toISOString()
                    }
                ]
            };
            await this.writeState(recovered);
            return recovered;
        }
        return existing;
    }

    private async bestEffortCleanupForRound(roundNumber: number): Promise<void> {
        // If the round started a worktree but errored mid-flight, the daemon's
        // in-memory activeRound has the spawned workers; SIGTERM and remove.
        if (this.state.activeRound != null) {
            for (const w of this.state.activeRound.spawned) {
                try {
                    w.process.kill("SIGTERM");
                } catch {
                    /* already dead */
                }
            }
            // Wait briefly for them to exit before removing worktrees
            await sleep(2000).catch(() => {});
        }
        this.state.activeRound = null;
        // Try to remove any tournament/r<NN>/* branches and worktrees
        const padded = String(roundNumber).padStart(2, "0");
        const { runCaptured } = await import("./spawn.js");
        try {
            const list = await runCaptured("git", ["branch", "--list", `tournament/r${padded}/*`], {
                cwd: this.paths.repoRoot
            });
            const branches = list.stdout
                .split("\n")
                .map((s) => s.replace("*", "").trim())
                .filter((s) => s.length > 0);
            for (const b of branches) {
                try {
                    const wtPath = `${this.paths.worktreeRoot}/r${padded}-${b.split("/").pop()}`;
                    await runCaptured("git", ["worktree", "remove", "--force", wtPath], {
                        cwd: this.paths.repoRoot
                    });
                } catch {
                    /* ignore */
                }
                try {
                    await runCaptured("git", ["branch", "-D", b], { cwd: this.paths.repoRoot });
                } catch {
                    /* ignore */
                }
            }
        } catch {
            /* ignore */
        }
    }

    private async runOneRound(
        state: TournamentState,
        roundNumber: number
    ): Promise<TournamentState> {
        this.scoredShas.clear();
        this.inFlightScores.clear();
        const { state: roundState, workers } = await startRound(
            { config: this.config, paths: this.paths, auditor: this.auditor },
            roundNumber
        );
        this.state.activeRound = { spawned: workers };

        const beforeRound: TournamentState = {
            ...state,
            currentRound: roundState
        };
        await this.writeState(beforeRound);

        const deadlineMs = Date.parse(roundState.deadline);
        this.exitedWorkers.clear();
        for (const w of workers) {
            w.process.result
                .then(() => this.exitedWorkers.add(w.process.pid))
                .catch(() => this.exitedWorkers.add(w.process.pid));
        }
        const scoringTask = this.runScoringLoop(roundState.workers, deadlineMs);

        await this.waitForRoundDeadline(workers, deadlineMs);

        // Round time is up. Terminate any survivors.
        await this.terminateAll(workers, roundNumber);

        // Drain scoring for any in-flight commits up to grace.
        const graceMs = this.config.graceMinutes * 60 * 1000;
        await this.drainScoring(scoringTask, graceMs);

        // Apply selection.
        const { selection } = await decideRound(
            { config: this.config, paths: this.paths, auditor: this.auditor },
            roundState
        );
        const apply = await applyWinner(
            { config: this.config, paths: this.paths, auditor: this.auditor },
            roundState,
            selection
        );

        const outcome: RoundOutcome = {
            round: roundNumber,
            winner:
                selection.winner != null
                    ? {
                          branch: selection.winner.branch,
                          sha: selection.winner.sha,
                          t1: selection.winner.aggregates.t1,
                          t2: selection.winner.aggregates.t2
                      }
                    : null,
            outcome: apply.outcome,
            completedAt: new Date().toISOString()
        };
        await this.auditor.log("round_end", { round: roundNumber, outcome: apply.outcome });

        await cleanupRound(
            { config: this.config, paths: this.paths, auditor: this.auditor },
            roundState
        );

        const updated: TournamentState = {
            ...beforeRound,
            currentRound: null,
            history: [...beforeRound.history, outcome]
        };
        await this.writeState(updated);
        this.state.activeRound = null;
        return updated;
    }

    private async runScoringLoop(
        workers: ReadonlyArray<WorkerState>,
        deadlineMs: number
    ): Promise<void> {
        while (
            !this.state.shouldStop &&
            Date.now() < deadlineMs + this.config.graceMinutes * 60 * 1000
        ) {
            for (const w of workers) {
                if (this.state.shouldStop) {
                    break;
                }
                const sentinel = join(w.worktree, ".tournament", "scoreme");
                if (!(await fileExists(sentinel))) {
                    continue;
                }
                try {
                    await unlink(sentinel);
                } catch {
                    // already consumed
                }
                let sha: string;
                try {
                    sha = await revParse(w.worktree, "HEAD");
                } catch {
                    continue;
                }
                if (this.scoredShas.has(sha) || this.inFlightScores.has(sha)) {
                    continue;
                }
                this.inFlightScores.add(sha);
                await this.auditor.log("scoreme_received", { branch: w.branch, sha });
                const job: ScoringJob = { branch: w.branch, sha, worktree: w.worktree };
                this.pool
                    .scoreSha(job)
                    .then(() => {
                        this.scoredShas.add(sha);
                    })
                    .catch(async (err) => {
                        await this.auditor.log("error", {
                            where: "scoring_loop:scoreSha",
                            branch: w.branch,
                            sha,
                            message: (err as Error).message
                        });
                    })
                    .finally(() => {
                        this.inFlightScores.delete(sha);
                    });
            }
            await sleep(this.config.scoringPollIntervalMs).catch(() => {});
        }
    }

    private async waitForRoundDeadline(
        workers: ReadonlyArray<SpawnedWorker>,
        deadlineMs: number
    ): Promise<void> {
        while (!this.state.shouldStop && Date.now() < deadlineMs) {
            const aliveCount = workers.filter((w) => !this.exitedWorkers.has(w.process.pid)).length;
            if (aliveCount === 0) {
                return;
            }
            const tickMs = Math.min(
                this.config.roundLoopIntervalMs,
                Math.max(1000, deadlineMs - Date.now())
            );
            await sleep(tickMs).catch(() => {});
        }
    }

    private async terminateAll(
        workers: ReadonlyArray<SpawnedWorker>,
        roundNumber: number
    ): Promise<void> {
        const graceMs = 30_000;
        await Promise.allSettled(
            workers.map((w) =>
                terminateWorker(w.process, graceMs, {
                    auditor: this.auditor,
                    round: roundNumber,
                    worker: w.state.id
                })
            )
        );
    }

    private async drainScoring(scoringTask: Promise<void>, graceMs: number): Promise<void> {
        const drain = Promise.race([
            scoringTask,
            sleep(graceMs).catch(() => undefined)
        ]);
        await drain;
        // Also wait for any in-flight scoring to finish, up to grace.
        const start = Date.now();
        while (this.inFlightScores.size > 0 && Date.now() - start < graceMs) {
            await sleep(1000).catch(() => {});
        }
    }

    private async loadState(): Promise<TournamentState | null> {
        return readJsonOrNull<TournamentState>(this.paths.stateFile);
    }

    private async writeState(state: TournamentState): Promise<void> {
        await writeJsonAtomic(this.paths.stateFile, state);
    }

    private installSignalHandlers(): void {
        const stop = (sig: NodeJS.Signals): void => {
            console.log(`[tournament] ${sig} received; stopping after current round wrap-up`);
            this.state.shouldStop = true;
        };
        process.on("SIGTERM", stop);
        process.on("SIGINT", stop);
    }

    private startCaffeinate(): void {
        try {
            this.caffeinate = spawn("caffeinate", ["-di"], {
                stdio: "ignore",
                detached: false
            });
        } catch {
            this.caffeinate = null;
        }
    }

    private stopCaffeinate(): void {
        if (this.caffeinate != null && this.caffeinate.exitCode == null) {
            try {
                this.caffeinate.kill("SIGTERM");
            } catch {
                /* ignore */
            }
        }
    }
}

export async function main(configPath: string): Promise<void> {
    const config = await loadConfig(configPath);
    const repoRoot = process.env.TOURNAMENT_REPO_ROOT ?? process.cwd();
    const paths = resolvePaths({ repoRoot });
    console.log(
        `[tournament] starting daemon: workers=${config.workersPerRound}, rounds=${config.roundDurationHours}h, model=${config.workerModel}, budget=$${config.workerBudgetUsd}`
    );
    console.log(`[tournament] paths.runtimeRoot=${paths.runtimeRoot}`);
    console.log(`[tournament] paths.worktreeRoot=${paths.worktreeRoot}`);
    console.log(`[tournament] paths.claudeBinary=${paths.claudeBinary}`);
    const daemon = new Daemon(config, paths);
    await daemon.run();
}

const invokedDirectly = (() => {
    const argv1 = process.argv[1];
    if (argv1 == null) {
        return false;
    }
    return argv1.endsWith("orchestrator.ts") || argv1.endsWith("orchestrator.js");
})();

if (invokedDirectly) {
    const configPath = process.argv[2] ?? "automation/tournament/config.json";
    main(configPath).catch((err: unknown) => {
        console.error("[tournament] daemon error:", err);
        process.exit(1);
    });
}
