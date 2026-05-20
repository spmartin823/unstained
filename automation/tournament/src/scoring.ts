/*
 * Scoring: ETE gate + 6-pair eval matrix fan-out, aggregation, atomic file writes.
 *
 * STUB — function signatures + atomic write helper. Implementation in a follow-up PR.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { EvalPairScorecard, Language, Score } from "./types.js";

export interface ScoringJob {
    readonly branch: string;
    readonly sha: string;
    readonly scorerWorktree: string;
}

export interface PairResult {
    readonly fixture: string;
    readonly language: Language;
    readonly scorecard: EvalPairScorecard;
}

export async function runEte(_scorerWorktree: string): Promise<"pass" | "fail"> {
    // TODO(phase-2-impl):
    //   exec `pnpm test:ete` in scorerWorktree with PATH=<Node 24 bin>:$PATH.
    //   Stream output to logs/scoring/<sha>-ete.log.
    //   Return "pass" iff exit code 0.
    throw new Error("runEte: not implemented (phase-2-impl)");
}

export async function runEvalPair(
    _scorerWorktree: string,
    _fixture: string,
    _language: Language
): Promise<EvalPairScorecard> {
    // TODO(phase-2-impl):
    //   exec `pnpm --filter stainless-equivalency-eval run <fixture> <language>`
    //   in scorerWorktree, capture the JSON scorecard written to
    //   stainless-equivalency-eval/reports/<fixture>-<language>.json, parse, return.
    throw new Error("runEvalPair: not implemented (phase-2-impl)");
}

export async function runEvalMatrix(
    _scorerWorktree: string,
    _fixtures: ReadonlyArray<string>,
    _languages: ReadonlyArray<Language>,
    _dockerConcurrency: number
): Promise<ReadonlyArray<PairResult>> {
    // TODO(phase-2-impl):
    //   Fan out runEvalPair() across fixtures × languages with a semaphore
    //   bounded by dockerConcurrency to avoid thrashing the Docker daemon.
    throw new Error("runEvalMatrix: not implemented (phase-2-impl)");
}

export async function checkGuardViolation(
    _scorerWorktree: string,
    _sha: string,
    _parentBranch: string
): Promise<string | null> {
    // TODO(phase-2-impl):
    //   exec `git diff --name-only <parentBranch>..<sha>`,
    //   return the first path matching `stainless-equivalency-eval/...` (or .gitmodules
    //   if the submodule gitlink changed), else null.
    throw new Error("checkGuardViolation: not implemented (phase-2-impl)");
}

export function aggregateScore(
    job: ScoringJob,
    ete: "pass" | "fail",
    pairResults: ReadonlyArray<PairResult>,
    guardViolation: string | null
): Score {
    const pairs: Record<string, EvalPairScorecard> = {};
    const behavioralValues: (number | null)[] = [];
    const signatureValues: number[] = [];
    const symbolValues: number[] = [];
    const fileValues: number[] = [];
    const structuralValues: number[] = [];

    for (const { fixture, language, scorecard } of pairResults) {
        pairs[`${fixture}-${language}`] = scorecard;
        behavioralValues.push(scorecard.behavioral);
        if (scorecard.signatureParity != null) {
            signatureValues.push(scorecard.signatureParity);
        }
        if (scorecard.symbolCoverage != null) {
            symbolValues.push(scorecard.symbolCoverage);
        }
        if (scorecard.fileCoverage != null) {
            fileValues.push(scorecard.fileCoverage);
        }
        if (scorecard.structural != null) {
            structuralValues.push(scorecard.structural);
        }
    }

    const meanOrZero = (xs: ReadonlyArray<number>): number =>
        xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

    const behavioralMean =
        behavioralValues.length === 0
            ? 0
            : behavioralValues.reduce<number>((acc, v) => acc + (v ?? 0), 0) / behavioralValues.length;
    const signatureMean = meanOrZero(signatureValues);
    const symbolMean = meanOrZero(symbolValues);
    const fileMean = meanOrZero(fileValues);
    const structuralMean = meanOrZero(structuralValues);
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

export async function writeScoreAtomic(scorePath: string, score: Score): Promise<void> {
    await mkdir(dirname(scorePath), { recursive: true });
    const tmp = `${scorePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(score, null, 2), "utf8");
    await rename(tmp, scorePath);
}
