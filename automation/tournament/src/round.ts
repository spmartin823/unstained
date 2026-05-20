import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureDir, fileExists } from "./atomic-fs.js";
import type { Auditor } from "./audit.js";
import { workerEnvFor } from "./config.js";
import { branchDelete, revParse, worktreeAdd, worktreeRemove } from "./git.js";
import { type ProcessResult, type RunningProcess, runCaptured, spawnLogged } from "./spawn.js";
import type { RoundState, TournamentConfig, TournamentPaths, WorkerState } from "./types.js";

const WORKER_INVOCATION = "Begin the tournament round per the prompt in `.context/tournament-worker.md`. Read `.context/worker.env` first.";

export interface SpawnedWorker {
    readonly state: WorkerState;
    readonly process: RunningProcess;
}

export interface RoundContext {
    readonly config: TournamentConfig;
    readonly paths: TournamentPaths;
    readonly auditor: Auditor;
}

function workerId(index: number): string {
    return `w${String(index).padStart(2, "0")}`;
}

function branchName(round: number, worker: string): string {
    return `tournament/r${String(round).padStart(2, "0")}/${worker}`;
}

function worktreePath(paths: TournamentPaths, round: number, worker: string): string {
    return join(paths.worktreeRoot, `r${String(round).padStart(2, "0")}-${worker}`);
}

function workerLogPath(paths: TournamentPaths, round: number, worker: string): string {
    return join(paths.logsDir, `r${String(round).padStart(2, "0")}-${worker}.log`);
}

async function seedWorkerWorktree(
    ctx: RoundContext,
    worktree: string,
    round: number,
    worker: string,
    deadlineIso: string
): Promise<void> {
    const contextDir = join(worktree, ".context");
    const tournamentDir = join(worktree, ".tournament");
    await ensureDir(contextDir);
    await ensureDir(tournamentDir);

    const promptContent = await readFile(ctx.paths.promptPath, "utf8");
    await writeFile(join(contextDir, "tournament-worker.md"), promptContent, "utf8");

    const env = workerEnvFor({
        round,
        worker,
        deadlineIso,
        tournamentRoot: ctx.paths.runtimeRoot
    });
    await writeFile(join(contextDir, "worker.env"), env, "utf8");
}

async function buildWorkerArgs(ctx: RoundContext, worktree: string): Promise<string[]> {
    const promptPath = join(worktree, ".context/tournament-worker.md");
    const prompt = await readFile(promptPath, "utf8");
    return [
        "--print",
        "--model",
        ctx.config.workerModel,
        "--max-budget-usd",
        String(ctx.config.workerBudgetUsd),
        "--dangerously-skip-permissions",
        "--allowedTools",
        "Bash,Edit,Read,Write,Glob,Grep,MultiEdit,NotebookEdit",
        "--append-system-prompt",
        prompt,
        WORKER_INVOCATION
    ];
}

async function initSubmodules(
    ctx: RoundContext,
    worktree: string,
    logPath: string
): Promise<void> {
    // git worktree add does not populate submodules in the new worktree.
    // Without this, stainless-equivalency-eval/ exists as a gitlink path but
    // its contents are empty in the worker worktree. pnpm install then drops
    // it from the workspace ("No projects matched the filters") and every
    // scoring call returns null metrics.
    const env: NodeJS.ProcessEnv = {
        PATH: `${ctx.paths.nodeBinaryDir}:${process.env.PATH ?? ""}`,
        HOME: process.env.HOME ?? ""
    };
    const result = await runCaptured("git", ["submodule", "update", "--init", "--recursive"], {
        cwd: worktree,
        env,
        timeoutMs: 5 * 60 * 1000
    });
    const status = result.exitCode === 0 ? "ok" : `fail-exit-${result.exitCode}`;
    const submoduleLogPath = `${logPath}.submodule.log`;
    try {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(
            submoduleLogPath,
            [
                `cwd=${worktree}`,
                `status=${status}`,
                "--- stdout ---",
                result.stdout,
                "--- stderr ---",
                result.stderr
            ].join("\n"),
            "utf8"
        );
    } catch {
        /* best-effort */
    }
    if (result.exitCode !== 0) {
        throw new Error(
            `git submodule update --init failed in ${worktree} (exit ${result.exitCode}); see ${submoduleLogPath}`
        );
    }
}

async function installDependencies(
    ctx: RoundContext,
    worktree: string,
    logPath: string
): Promise<void> {
    // Each git worktree gets a fresh checkout with no node_modules. Without
    // this, both worker self-tests (pnpm compile, pnpm test) and daemon
    // scoring (pnpm --filter stainless-equivalency-eval exec ...) fail because
    // workspace dependencies aren't installed in the worktree.
    const env: NodeJS.ProcessEnv = {
        PATH: `${ctx.paths.nodeBinaryDir}:${process.env.PATH ?? ""}`,
        HOME: process.env.HOME ?? ""
    };
    const result = await runCaptured(ctx.paths.pnpmBinary, ["install"], {
        cwd: worktree,
        env,
        timeoutMs: 10 * 60 * 1000
    });
    const status = result.exitCode === 0 ? "ok" : `fail-exit-${result.exitCode}`;
    const installLogPath = `${logPath}.install.log`;
    try {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(
            installLogPath,
            [
                `cwd=${worktree}`,
                `status=${status}`,
                "--- stdout ---",
                result.stdout,
                "--- stderr ---",
                result.stderr
            ].join("\n"),
            "utf8"
        );
    } catch {
        /* best-effort */
    }
    if (result.exitCode !== 0) {
        throw new Error(
            `pnpm install failed in ${worktree} (exit ${result.exitCode}); see ${installLogPath}`
        );
    }
}

async function spawnWorker(
    ctx: RoundContext,
    worktree: string,
    logPath: string
): Promise<RunningProcess> {
    if (process.env.TOURNAMENT_SMOKE === "1") {
        return spawnSmokeWorker(worktree, logPath);
    }
    const args = await buildWorkerArgs(ctx, worktree);
    return spawnLogged(ctx.paths.claudeBinary, args, {
        cwd: worktree,
        env: {
            PATH: `${ctx.paths.nodeBinaryDir}:${process.env.PATH ?? ""}`,
            CLAUDE_CODE_SIMPLE: "0"
        },
        logPath
    });
}

function spawnSmokeWorker(worktree: string, logPath: string): RunningProcess {
    // Fake worker for end-to-end smoke testing. Makes one trivial commit
    // (in tournament/notes/ so the allowlist accepts it), touches scoreme,
    // then idles until the daemon SIGTERMs it.
    const script = [
        "set -eu",
        "mkdir -p tournament/notes .tournament",
        'echo "[smoke] $(date -u +%Y-%m-%dT%H:%M:%SZ)" > tournament/notes/smoke.log',
        "git add tournament/notes/smoke.log",
        'git -c user.email=smoke@example.com -c user.name=smoke commit -m "smoke: trivial change" --no-verify',
        "touch .tournament/scoreme",
        "while true; do sleep 5; done"
    ].join("\n");
    return spawnLogged("bash", ["-c", script], {
        cwd: worktree,
        logPath
    });
}

export async function startRound(
    ctx: RoundContext,
    roundNumber: number
): Promise<{ state: RoundState; workers: SpawnedWorker[] }> {
    const now = new Date();
    const deadline = new Date(now.getTime() + ctx.config.roundDurationHours * 3600 * 1000);
    const deadlineIso = deadline.toISOString();

    const spawned: SpawnedWorker[] = [];
    const workerStates: WorkerState[] = [];

    for (let i = 1; i <= ctx.config.workersPerRound; i += 1) {
        const worker = workerId(i);
        const branch = branchName(roundNumber, worker);
        const worktree = worktreePath(ctx.paths, roundNumber, worker);
        const logPath = workerLogPath(ctx.paths, roundNumber, worker);

        await ensureDir(ctx.paths.logsDir);
        await worktreeAdd(ctx.paths.repoRoot, worktree, branch, ctx.config.parentBranch);
        await initSubmodules(ctx, worktree, logPath);
        await seedWorkerWorktree(ctx, worktree, roundNumber, worker, deadlineIso);
        await installDependencies(ctx, worktree, logPath);

        const proc = await spawnWorker(ctx, worktree, logPath);

        const state: WorkerState = {
            id: worker,
            branch,
            worktree,
            pid: proc.pid,
            log: logPath,
            startedAt: now.toISOString()
        };
        workerStates.push(state);
        spawned.push({ state, process: proc });

        await ctx.auditor.log("worker_spawned", {
            round: roundNumber,
            worker,
            branch,
            worktree,
            pid: proc.pid,
            deadline: deadlineIso
        });
    }

    const roundState: RoundState = {
        number: roundNumber,
        startedAt: now.toISOString(),
        deadline: deadlineIso,
        workers: workerStates
    };

    await ctx.auditor.log("round_start", {
        round: roundNumber,
        deadline: deadlineIso,
        workers: workerStates.map((w) => w.id),
        parentSha: await revParse(ctx.paths.repoRoot, ctx.config.parentBranch)
    });

    return { state: roundState, workers: spawned };
}

export async function terminateWorker(
    proc: RunningProcess,
    graceMs: number,
    audit?: { auditor: Auditor; round: number; worker: string }
): Promise<ProcessResult> {
    proc.kill("SIGTERM");
    if (audit != null) {
        await audit.auditor.log("worker_exit", {
            round: audit.round,
            worker: audit.worker,
            reason: "sigterm_requested"
        });
    }
    const winner = await Promise.race([
        proc.result,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), graceMs))
    ]);
    if (winner === "timeout") {
        proc.kill("SIGKILL");
        return proc.result;
    }
    return winner;
}

export async function cleanupRound(
    ctx: RoundContext,
    round: RoundState
): Promise<void> {
    for (const w of round.workers) {
        try {
            if (await fileExists(w.worktree)) {
                await worktreeRemove(ctx.paths.repoRoot, w.worktree);
            }
        } catch (err) {
            await ctx.auditor.log("error", {
                where: "cleanupRound:worktreeRemove",
                worktree: w.worktree,
                message: (err as Error).message
            });
        }
        try {
            await branchDelete(ctx.paths.repoRoot, w.branch);
        } catch (err) {
            // Branch may have been merged + deleted already; ignore.
            const msg = (err as Error).message;
            if (!/not found|already deleted/i.test(msg)) {
                await ctx.auditor.log("error", {
                    where: "cleanupRound:branchDelete",
                    branch: w.branch,
                    message: msg
                });
            }
        }
    }
    await ctx.auditor.log("cleanup", { round: round.number, workers: round.workers.length });
}
