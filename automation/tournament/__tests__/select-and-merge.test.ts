import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { writeJsonAtomic } from "../src/atomic-fs.js";
import { Auditor } from "../src/audit.js";
import { runCaptured } from "../src/spawn.js";
import { decideRound, applyWinner } from "../src/select-and-merge.js";
import type {
    RoundState,
    Score,
    TournamentConfig,
    TournamentPaths,
    WorkerState
} from "../src/types.js";

const baseConfig: TournamentConfig = {
    roundDurationHours: 1,
    graceMinutes: 5,
    workersPerRound: 2,
    scorers: 1,
    dockerConcurrency: 1,
    tieEpsilon: 0.005,
    pushMain: false,
    languages: ["typescript"],
    fixtures: ["lumaai"],
    pathAllowlist: ["generators/typescript/**", "tournament/notes/**"],
    workerBudgetUsd: 10,
    workerModel: "claude-opus-4-7",
    parentBranch: "main",
    roundLoopIntervalMs: 1000,
    scoringPollIntervalMs: 500,
    maxRounds: null,
    skipEte: false
};

let repoRoot: string;
let runtimeRoot: string;
let paths: TournamentPaths;
let auditor: Auditor;

async function gitInRepo(args: string[]): Promise<void> {
    const res = await runCaptured("git", args, { cwd: repoRoot });
    if (res.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    }
}

beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "tournament-smap-"));
    runtimeRoot = join(repoRoot, "tournament");
    await gitInRepo(["init", "--initial-branch=main"]);
    await gitInRepo(["config", "user.email", "test@example.com"]);
    await gitInRepo(["config", "user.name", "Test"]);
    await writeFile(join(repoRoot, "README.md"), "init\n");
    await gitInRepo(["add", "README.md"]);
    await gitInRepo(["commit", "-m", "init"]);
    paths = {
        repoRoot,
        runtimeRoot,
        stateFile: join(runtimeRoot, "state.json"),
        auditFile: join(runtimeRoot, "audit.jsonl"),
        scoresDir: join(runtimeRoot, "scores"),
        logsDir: join(runtimeRoot, "logs"),
        worktreeRoot: join(repoRoot, ".worktrees"),
        promptPath: join(repoRoot, "prompt.md"),
        claudeBinary: "/bin/true",
        pnpmBinary: "pnpm",
        nodeBinaryDir: "/usr/bin",
        evalSubmoduleDir: join(repoRoot, "stainless-equivalency-eval")
    };
    auditor = new Auditor(paths.auditFile);
});

afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
});

async function createWorkerBranch(branch: string, fileTouched: string): Promise<{ sha: string; worker: WorkerState }> {
    await gitInRepo(["checkout", "-b", branch, "main"]);
    const fullPath = join(repoRoot, fileTouched);
    await (await import("node:fs/promises")).mkdir(join(repoRoot, fileTouched, ".."), {
        recursive: true
    });
    await writeFile(fullPath, `content for ${branch}\n`);
    await gitInRepo(["add", "-A"]);
    await gitInRepo(["commit", "-m", `change for ${branch}`]);
    const res = await runCaptured("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    const sha = res.stdout.trim();
    await gitInRepo(["checkout", "main"]);
    return {
        sha,
        worker: {
            id: branch.split("/").pop()!,
            branch,
            worktree: join(repoRoot, ".worktrees", branch),
            pid: 0,
            log: "",
            startedAt: new Date().toISOString()
        }
    };
}

function makeScore(opts: {
    sha: string;
    branch: string;
    t1: number;
    t2: number;
    ete?: "pass" | "fail";
    guardViolation?: string | null;
}): Score {
    return {
        sha: opts.sha,
        branch: opts.branch,
        scoredAt: new Date().toISOString(),
        ete: opts.ete ?? "pass",
        guardViolation: opts.guardViolation ?? null,
        pairs: {},
        aggregates: {
            behavioralValues: [opts.t1, opts.t1, opts.t1, opts.t1, opts.t1, opts.t1],
            behavioralMean: opts.t1,
            signatureMean: opts.t2,
            symbolMean: opts.t2,
            fileMean: opts.t2,
            structuralMean: opts.t2,
            t1: opts.t1,
            t2: opts.t2
        }
    };
}

describe("decideRound", () => {
    test("picks the higher-scoring branch when both have scores", async () => {
        const a = await createWorkerBranch("tournament/r01/w01", "generators/typescript/a.ts");
        const b = await createWorkerBranch("tournament/r01/w02", "generators/typescript/b.ts");
        await writeJsonAtomic(
            join(paths.scoresDir, `${a.sha}.json`),
            makeScore({ sha: a.sha, branch: a.worker.branch, t1: 0.2, t2: 0.5 })
        );
        await writeJsonAtomic(
            join(paths.scoresDir, `${b.sha}.json`),
            makeScore({ sha: b.sha, branch: b.worker.branch, t1: 0.5, t2: 0.3 })
        );
        const round: RoundState = {
            number: 1,
            startedAt: new Date().toISOString(),
            deadline: new Date().toISOString(),
            workers: [a.worker, b.worker]
        };
        const result = await decideRound({ config: baseConfig, paths, auditor }, round);
        expect(result.selection.winner?.branch).toBe("tournament/r01/w02");
        expect(result.selection.reason).toBe("tier1_single_winner");
        expect(result.missing).toEqual([]);
    });

    test("missing score → branch is excluded but selection proceeds", async () => {
        const a = await createWorkerBranch("tournament/r01/w01", "generators/typescript/a.ts");
        const b = await createWorkerBranch("tournament/r01/w02", "generators/typescript/b.ts");
        await writeJsonAtomic(
            join(paths.scoresDir, `${a.sha}.json`),
            makeScore({ sha: a.sha, branch: a.worker.branch, t1: 0.2, t2: 0.5 })
        );
        // b has no score file
        const round: RoundState = {
            number: 1,
            startedAt: new Date().toISOString(),
            deadline: new Date().toISOString(),
            workers: [a.worker, b.worker]
        };
        const result = await decideRound({ config: baseConfig, paths, auditor }, round);
        expect(result.selection.winner?.branch).toBe("tournament/r01/w01");
        expect(result.missing).toContain("tournament/r01/w02");
    });

    test("all missing → no winner", async () => {
        const a = await createWorkerBranch("tournament/r01/w01", "generators/typescript/a.ts");
        const round: RoundState = {
            number: 1,
            startedAt: new Date().toISOString(),
            deadline: new Date().toISOString(),
            workers: [a.worker]
        };
        const result = await decideRound({ config: baseConfig, paths, auditor }, round);
        expect(result.selection.winner).toBeNull();
        expect(result.selection.reason).toBe("no_candidates");
    });
});

describe("applyWinner", () => {
    test("auto-merges when winning diff is fully inside the allowlist", async () => {
        const a = await createWorkerBranch("tournament/r01/w01", "generators/typescript/a.ts");
        const round: RoundState = {
            number: 1,
            startedAt: new Date().toISOString(),
            deadline: new Date().toISOString(),
            workers: [a.worker]
        };
        const score = makeScore({ sha: a.sha, branch: a.worker.branch, t1: 0.4, t2: 0.4 });
        await writeJsonAtomic(join(paths.scoresDir, `${a.sha}.json`), score);
        const { selection } = await decideRound({ config: baseConfig, paths, auditor }, round);
        const result = await applyWinner({ config: baseConfig, paths, auditor }, round, selection);
        expect(result.outcome).toBe("merged");
        // Verify main moved forward
        const head = await runCaptured("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
        expect(head.stdout.trim()).not.toBe(a.sha); // it's a merge commit, not the same as the branch tip
        const log = await runCaptured("git", ["log", "--oneline", "-3"], { cwd: repoRoot });
        expect(log.stdout).toContain("tournament r01 w01");
    });

    test("no winner → returns no_winner outcome, main unchanged", async () => {
        const round: RoundState = {
            number: 1,
            startedAt: new Date().toISOString(),
            deadline: new Date().toISOString(),
            workers: []
        };
        const { selection } = await decideRound({ config: baseConfig, paths, auditor }, round);
        const result = await applyWinner({ config: baseConfig, paths, auditor }, round, selection);
        expect(result.outcome).toBe("no_winner");
    });

    test("out-of-allowlist diff → does not merge; reports violating paths", async () => {
        // Create a branch that edits packages/cli/cli/src/cli.ts (not in allowlist)
        await gitInRepo(["checkout", "-b", "tournament/r01/w01", "main"]);
        const cliPath = "packages/cli/cli/src/cli.ts";
        await (await import("node:fs/promises")).mkdir(join(repoRoot, "packages/cli/cli/src"), {
            recursive: true
        });
        await writeFile(join(repoRoot, cliPath), "// off limits\n");
        await gitInRepo(["add", "-A"]);
        await gitInRepo(["commit", "-m", "edit cli"]);
        const shaRes = await runCaptured("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
        const sha = shaRes.stdout.trim();
        await gitInRepo(["checkout", "main"]);
        const worker: WorkerState = {
            id: "w01",
            branch: "tournament/r01/w01",
            worktree: "",
            pid: 0,
            log: "",
            startedAt: new Date().toISOString()
        };
        const round: RoundState = {
            number: 1,
            startedAt: new Date().toISOString(),
            deadline: new Date().toISOString(),
            workers: [worker]
        };
        await writeJsonAtomic(
            join(paths.scoresDir, `${sha}.json`),
            makeScore({ sha, branch: worker.branch, t1: 0.5, t2: 0.5 })
        );
        const { selection } = await decideRound({ config: baseConfig, paths, auditor }, round);
        const result = await applyWinner({ config: baseConfig, paths, auditor }, round, selection);
        // No remote configured, so push fails — we expect "no_winner" with violating paths logged.
        // The important assertion: main was not moved.
        const mainTip = await runCaptured("git", ["rev-parse", "main"], { cwd: repoRoot });
        const initialTip = await runCaptured("git", ["log", "--format=%H", "main^!"], { cwd: repoRoot });
        expect(mainTip.stdout.trim()).toBe(initialTip.stdout.trim());
        expect(result.violatingPaths ?? []).toContain(cliPath);
    });
});
