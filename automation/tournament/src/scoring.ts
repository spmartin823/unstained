import { join } from "node:path";

import { ensureDir, readJson, writeJsonAtomic } from "./atomic-fs.js";
import type { Auditor } from "./audit.js";
import { Semaphore } from "./concurrency.js";
import { configEvalSubmoduleIsClean, revParse } from "./git.js";
import { runCaptured } from "./spawn.js";
import type {
    EvalPairScorecard,
    EteOutcome,
    Language,
    Score,
    ScoreAggregates,
    TournamentConfig,
    TournamentPaths
} from "./types.js";

const EVAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 min per pair
const ETE_TIMEOUT_MS = 45 * 60 * 1000;

export interface ScoringJob {
    readonly branch: string;
    readonly sha: string;
    readonly worktree: string;
}

interface PairScoreResult {
    readonly fixture: string;
    readonly language: Language;
    readonly scorecard: EvalPairScorecard;
}

export class ScoringPool {
    private readonly scorerSem: Semaphore;
    private readonly dockerSem: Semaphore;

    constructor(
        private readonly ctx: { config: TournamentConfig; paths: TournamentPaths; auditor: Auditor }
    ) {
        this.scorerSem = new Semaphore(ctx.config.scorers);
        this.dockerSem = new Semaphore(ctx.config.dockerConcurrency);
    }

    async scoreSha(job: ScoringJob): Promise<Score> {
        return this.scorerSem.withPermit(async () => {
            await this.ctx.auditor.log("scoring_start", {
                branch: job.branch,
                sha: job.sha,
                worktree: job.worktree
            });
            try {
                const score = await this.scoreInner(job);
                await this.ctx.auditor.log("scoring_complete", {
                    branch: job.branch,
                    sha: job.sha,
                    ete: score.ete,
                    guardViolation: score.guardViolation,
                    t1: score.aggregates.t1,
                    t2: score.aggregates.t2
                });
                return score;
            } catch (err) {
                await this.ctx.auditor.log("error", {
                    where: "scoring",
                    branch: job.branch,
                    sha: job.sha,
                    message: (err as Error).message
                });
                throw err;
            }
        });
    }

    private async scoreInner(job: ScoringJob): Promise<Score> {
        if (process.env.TOURNAMENT_SMOKE === "1") {
            return this.scoreSmoke(job);
        }
        const parentSha = await revParse(this.ctx.paths.repoRoot, this.ctx.config.parentBranch);
        const guardViolation = await configEvalSubmoduleIsClean(
            job.worktree,
            parentSha,
            job.sha
        );
        if (guardViolation != null) {
            const dq = emptyScore(job, "fail", guardViolation);
            await this.writeScore(job, dq);
            return dq;
        }

        // Rebuild Fern CLI from the worker's source so generator changes
        // actually surface in the eval. Without this, the eval invokes the
        // dist/prod/cli.cjs we mirrored from main at startRound — workers
        // editing generators/typescript/** see no metric change.
        await this.rebuildFern(job);

        let ete: EteOutcome;
        if (this.ctx.config.skipEte) {
            ete = "pass";
        } else {
            ete = await this.runEte(job);
            if (ete === "fail") {
                const score = emptyScore(job, "fail", null);
                await this.writeScore(job, score);
                return score;
            }
        }

        const pairs = await this.runEvalMatrix(job);
        const score = aggregateScore(job, ete, null, pairs);
        await this.writeScore(job, score);
        return score;
    }

    private async scoreSmoke(job: ScoringJob): Promise<Score> {
        // Deterministic but slightly varied scores so selection has a real winner
        // to pick. Hash the sha string for a stable per-branch number.
        const seed = [...job.sha].reduce((a, c) => a + c.charCodeAt(0), 0);
        const baseline = ((seed % 100) / 1000); // 0.000 to 0.099
        const allPairs: Array<{ fixture: string; language: Language; scorecard: EvalPairScorecard }> = [];
        for (const fixture of this.ctx.config.fixtures) {
            for (const language of this.ctx.config.languages) {
                allPairs.push({
                    fixture,
                    language,
                    scorecard: {
                        behavioral: baseline + 0.1,
                        signatureParity: baseline + 0.5,
                        symbolCoverage: baseline + 0.6,
                        fileCoverage: baseline + 0.8,
                        structural: baseline + 0.7,
                        composite: baseline + 0.4
                    }
                });
            }
        }
        const score = aggregateScore(job, "pass", null, allPairs);
        await this.writeScore(job, score);
        return score;
    }

    private async writeScore(job: ScoringJob, score: Score): Promise<void> {
        const canonical = join(this.ctx.paths.scoresDir, `${job.sha}.json`);
        await writeJsonAtomic(canonical, score);
        const workerSnapshot = join(job.worktree, ".tournament", "score.json");
        await ensureDir(join(job.worktree, ".tournament"));
        await writeJsonAtomic(workerSnapshot, score);
    }

    private async rebuildFern(job: ScoringJob): Promise<void> {
        const env = pnpmEnv(this.ctx.paths);
        const MAX = 1_000_000;
        const truncate = (s: string): string =>
            s.length > MAX ? `${s.slice(0, MAX)}\n[... truncated ${s.length - MAX} bytes ...]` : s;
        const { writeFile } = await import("node:fs/promises");
        await ensureDir(this.ctx.paths.logsDir);

        // Two-part rebuild:
        //   1) pnpm fern:build → packages/cli/cli/dist/prod/cli.cjs
        //   2) generators/typescript/sdk/cli dockerTagLatest → local image
        //      'fernapi/fern-typescript-sdk:latest' that fern generate --local
        //      picks up instead of the published one.
        //
        // Without (2) the generator runs the published Docker image regardless
        // of the worker's source edits, so symbol/file/structural metrics
        // never move. Python uses a different build pipeline (pyenv-managed,
        // no pnpm script) — skipped for now; TS-only rebuild means workers
        // can only move TS-side metrics.
        const steps: Array<{
            name: string;
            cwd: string;
            args: string[];
            timeoutMs: number;
        }> = [
            {
                name: "fern-cli",
                cwd: job.worktree,
                args: ["fern:build"],
                timeoutMs: 20 * 60 * 1000
            },
            {
                name: "ts-sdk-docker",
                cwd: `${job.worktree}/generators/typescript/sdk/cli`,
                args: ["run", "dockerTagLatest"],
                timeoutMs: 20 * 60 * 1000
            }
        ];

        const sections: string[] = [];
        for (const step of steps) {
            const start = Date.now();
            const result = await runCaptured(this.ctx.paths.pnpmBinary, step.args, {
                cwd: step.cwd,
                env,
                timeoutMs: step.timeoutMs
            });
            sections.push(
                [
                    `=== ${step.name} ===`,
                    `cwd=${step.cwd}`,
                    `cmd=pnpm ${step.args.join(" ")}`,
                    `exit=${result.exitCode}`,
                    `duration_ms=${Date.now() - start}`,
                    "--- stdout ---",
                    truncate(result.stdout ?? ""),
                    "--- stderr ---",
                    truncate(result.stderr ?? "")
                ].join("\n")
            );
        }
        const logPath = join(this.ctx.paths.logsDir, `scoring-${job.sha}-rebuild.log`);
        try {
            await writeFile(logPath, sections.join("\n\n"), "utf8");
        } catch {
            /* best-effort */
        }
        // Non-fatal: if any step fails, fall through to the eval anyway.
        // The eval will produce whatever it can; logs are inspectable for diagnosis.
    }

    private async runEte(job: ScoringJob): Promise<EteOutcome> {
        const env = pnpmEnv(this.ctx.paths);
        const res = await runCaptured(this.ctx.paths.pnpmBinary, ["test:ete"], {
            cwd: job.worktree,
            env,
            timeoutMs: ETE_TIMEOUT_MS
        });
        // Persist stdout+stderr so failures are diagnosable. Truncated at 1 MB
        // each to keep logs manageable.
        const logPath = join(this.ctx.paths.logsDir, `scoring-${job.sha}-ete.log`);
        const MAX = 1_000_000;
        const truncate = (s: string): string =>
            s.length > MAX ? `${s.slice(0, MAX)}\n[... truncated ${s.length - MAX} bytes ...]` : s;
        const body = [
            `exit=${res.exitCode}`,
            `sha=${job.sha}`,
            `branch=${job.branch}`,
            `worktree=${job.worktree}`,
            "--- stdout ---",
            truncate(res.stdout ?? ""),
            "--- stderr ---",
            truncate(res.stderr ?? "")
        ].join("\n");
        try {
            await ensureDir(this.ctx.paths.logsDir);
            await (await import("node:fs/promises")).writeFile(logPath, body, "utf8");
        } catch {
            /* logging is best-effort */
        }
        return res.exitCode === 0 ? "pass" : "fail";
    }

    private async runEvalMatrix(job: ScoringJob): Promise<ReadonlyArray<PairScoreResult>> {
        const tasks: Array<Promise<PairScoreResult>> = [];
        for (const fixture of this.ctx.config.fixtures) {
            for (const language of this.ctx.config.languages) {
                tasks.push(this.dockerSem.withPermit(() => this.runEvalPair(job, fixture, language)));
            }
        }
        return Promise.all(tasks);
    }

    private async runEvalPair(
        job: ScoringJob,
        fixture: string,
        language: Language
    ): Promise<PairScoreResult> {
        const env = pnpmEnv(this.ctx.paths);
        // Eval package CLI: `pnpm --filter stainless-equivalency-eval run <fixture> <language>`
        const res = await runCaptured(
            this.ctx.paths.pnpmBinary,
            [
                "--filter",
                "stainless-equivalency-eval",
                "exec",
                "tsx",
                "src/cli.ts",
                "run",
                fixture,
                language
            ],
            { cwd: job.worktree, env, timeoutMs: EVAL_TIMEOUT_MS }
        );
        // Persist eval-pair output for diagnostics.
        const logPath = join(
            this.ctx.paths.logsDir,
            `scoring-${job.sha}-${fixture}-${language}.log`
        );
        const MAX = 1_000_000;
        const truncate = (s: string): string =>
            s.length > MAX ? `${s.slice(0, MAX)}\n[... truncated ${s.length - MAX} bytes ...]` : s;
        try {
            await ensureDir(this.ctx.paths.logsDir);
            await (await import("node:fs/promises")).writeFile(
                logPath,
                [
                    `exit=${res.exitCode}`,
                    `pair=${fixture}-${language}`,
                    `sha=${job.sha}`,
                    "--- stdout ---",
                    truncate(res.stdout ?? ""),
                    "--- stderr ---",
                    truncate(res.stderr ?? "")
                ].join("\n"),
                "utf8"
            );
        } catch {
            /* best-effort */
        }
        if (res.exitCode !== 0) {
            return {
                fixture,
                language,
                scorecard: nullPairScorecard()
            };
        }
        const reportPath = join(
            job.worktree,
            "stainless-equivalency-eval",
            "reports",
            `${fixture}-${language}.json`
        );
        try {
            const report = await readJson<EvalReportFile>(reportPath);
            return {
                fixture,
                language,
                scorecard: extractScorecard(report)
            };
        } catch {
            return { fixture, language, scorecard: nullPairScorecard() };
        }
    }
}

interface EvalReportFile {
    readonly metrics?: {
        // Eval emits these exact keys (run.ts ScorecardMetrics): behavioral,
        // signature, symbol, file, structural. Our interface mirrors them
        // exactly — earlier camelCased aliases (signatureParity, etc.) silently
        // dropped three of the five metrics on every scoring call.
        readonly behavioral?: { value: number | null };
        readonly signature?: { value: number | null };
        readonly symbol?: { value: number | null };
        readonly file?: { value: number | null };
        readonly structural?: { value: number | null };
    };
    readonly composite?: { value?: number | null } | number | null;
}

function extractScorecard(report: EvalReportFile): EvalPairScorecard {
    const composite =
        typeof report.composite === "object" && report.composite != null
            ? (report.composite.value ?? null)
            : (report.composite ?? null);
    return {
        behavioral: report.metrics?.behavioral?.value ?? null,
        signatureParity: report.metrics?.signature?.value ?? null,
        symbolCoverage: report.metrics?.symbol?.value ?? null,
        fileCoverage: report.metrics?.file?.value ?? null,
        structural: report.metrics?.structural?.value ?? null,
        composite
    };
}

function nullPairScorecard(): EvalPairScorecard {
    return {
        behavioral: null,
        signatureParity: null,
        symbolCoverage: null,
        fileCoverage: null,
        structural: null,
        composite: null
    };
}

function pnpmEnv(paths: TournamentPaths): NodeJS.ProcessEnv {
    // Keep HOME so pnpm/corepack honor user-level config (e.g. ~/.npmrc,
    // ~/.config/corepack/). Without HOME, corepack defaults to /var/empty and
    // breaks for some users — diagnosed by tournament worker r01-w02.
    return {
        PATH: `${paths.nodeBinaryDir}:${process.env.PATH ?? ""}`,
        HOME: process.env.HOME ?? "",
        FORCE_COLOR: "0"
    };
}

function emptyScore(job: ScoringJob, ete: EteOutcome, guardViolation: string | null): Score {
    const behavioralValues = [null, null, null, null, null, null];
    const aggregates: ScoreAggregates = {
        behavioralValues,
        behavioralMean: 0,
        signatureMean: 0,
        symbolMean: 0,
        fileMean: 0,
        structuralMean: 0,
        t1: 0,
        t2: 0
    };
    return {
        sha: job.sha,
        branch: job.branch,
        scoredAt: new Date().toISOString(),
        ete,
        guardViolation,
        pairs: {},
        aggregates
    };
}

export function aggregateScore(
    job: ScoringJob,
    ete: EteOutcome,
    guardViolation: string | null,
    pairResults: ReadonlyArray<PairScoreResult>
): Score {
    const pairs: Record<string, EvalPairScorecard> = {};
    const behavioralValues: (number | null)[] = [];
    const sig: number[] = [];
    const sym: number[] = [];
    const file: number[] = [];
    const struct: number[] = [];

    for (const { fixture, language, scorecard } of pairResults) {
        pairs[`${fixture}-${language}`] = scorecard;
        behavioralValues.push(scorecard.behavioral);
        if (scorecard.signatureParity != null) {
            sig.push(scorecard.signatureParity);
        }
        if (scorecard.symbolCoverage != null) {
            sym.push(scorecard.symbolCoverage);
        }
        if (scorecard.fileCoverage != null) {
            file.push(scorecard.fileCoverage);
        }
        if (scorecard.structural != null) {
            struct.push(scorecard.structural);
        }
    }

    const meanOr0 = (xs: ReadonlyArray<number>): number =>
        xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

    const behavioralMean =
        behavioralValues.length === 0
            ? 0
            : behavioralValues.reduce<number>((acc, v) => acc + (v ?? 0), 0) / behavioralValues.length;
    const signatureMean = meanOr0(sig);
    const symbolMean = meanOr0(sym);
    const fileMean = meanOr0(file);
    const structuralMean = meanOr0(struct);
    const t1 = behavioralMean;
    const t2 = signatureMean * 0.5 + symbolMean * 0.3 + fileMean * 0.1 + structuralMean * 0.1;

    return {
        sha: job.sha,
        branch: job.branch,
        scoredAt: new Date().toISOString(),
        ete,
        guardViolation,
        pairs,
        aggregates: {
            behavioralValues,
            behavioralMean,
            signatureMean,
            symbolMean,
            fileMean,
            structuralMean,
            t1,
            t2
        }
    };
}
