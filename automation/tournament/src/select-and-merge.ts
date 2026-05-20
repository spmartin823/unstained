import { join } from "node:path";

import { checkAllowlist } from "./allowlist.js";
import { readJsonOrNull } from "./atomic-fs.js";
import type { Auditor } from "./audit.js";
import { checkoutBranch, diffNameOnly, mergeNoFf, pushBranch, revParse } from "./git.js";
import { selectWinner } from "./selection.js";
import type {
    RoundOutcome,
    RoundState,
    Score,
    SelectionResult,
    TournamentConfig,
    TournamentPaths
} from "./types.js";

export interface SelectionContext {
    readonly config: TournamentConfig;
    readonly paths: TournamentPaths;
    readonly auditor: Auditor;
}

async function loadScoresForRound(
    ctx: SelectionContext,
    round: RoundState
): Promise<{ scores: Score[]; missing: ReadonlyArray<string> }> {
    const scores: Score[] = [];
    const missing: string[] = [];
    for (const w of round.workers) {
        let sha: string;
        try {
            sha = await revParse(ctx.paths.repoRoot, w.branch);
        } catch {
            missing.push(w.branch);
            continue;
        }
        const scorePath = join(ctx.paths.scoresDir, `${sha}.json`);
        const score = await readJsonOrNull<Score>(scorePath);
        if (score == null) {
            missing.push(w.branch);
            continue;
        }
        scores.push(score);
    }
    return { scores, missing };
}

export async function decideRound(
    ctx: SelectionContext,
    round: RoundState
): Promise<{
    selection: SelectionResult;
    scores: ReadonlyArray<Score>;
    missing: ReadonlyArray<string>;
}> {
    const { scores, missing } = await loadScoresForRound(ctx, round);
    const selection = selectWinner(scores, ctx.config.tieEpsilon);
    await ctx.auditor.log("selection", {
        round: round.number,
        reason: selection.reason,
        winner: selection.winner != null
            ? { branch: selection.winner.branch, sha: selection.winner.sha }
            : null,
        candidates: scores.length,
        missing,
        disqualified: selection.disqualified
    });
    return { selection, scores, missing };
}

export interface ApplyWinnerResult {
    readonly outcome: RoundOutcome["outcome"];
    readonly prBranch?: string;
    readonly violatingPaths?: ReadonlyArray<string>;
}

export async function applyWinner(
    ctx: SelectionContext,
    round: RoundState,
    selection: SelectionResult
): Promise<ApplyWinnerResult> {
    if (selection.winner == null) {
        return { outcome: "no_winner" };
    }
    const winner = selection.winner;
    const changedPaths = await diffNameOnly(
        ctx.paths.repoRoot,
        ctx.config.parentBranch,
        winner.branch
    );
    const allow = checkAllowlist(changedPaths, ctx.config.pathAllowlist);
    if (!allow.ok) {
        const prBranch = `tournament-pr/r${String(round.number).padStart(2, "0")}-${winner.branch.split("/").pop()}`;
        try {
            await pushBranch(ctx.paths.repoRoot, winner.branch, prBranch);
        } catch (err) {
            await ctx.auditor.log("error", {
                where: "applyWinner:pushBranchForPR",
                branch: winner.branch,
                message: (err as Error).message
            });
            return { outcome: "no_winner", violatingPaths: allow.violatingPaths };
        }
        await ctx.auditor.log("pr_opened", {
            round: round.number,
            winner: winner.branch,
            sha: winner.sha,
            prBranch,
            violatingPaths: allow.violatingPaths,
            t1: winner.aggregates.t1,
            t2: winner.aggregates.t2
        });
        return { outcome: "pr", prBranch, violatingPaths: allow.violatingPaths };
    }
    const msg = `tournament r${String(round.number).padStart(2, "0")} ${winner.branch.split("/").pop()}\n\nb=${winner.aggregates.t1.toFixed(4)} nb=${winner.aggregates.t2.toFixed(4)} sha=${winner.sha}`;
    await checkoutBranch(ctx.paths.repoRoot, ctx.config.parentBranch);
    await mergeNoFf(ctx.paths.repoRoot, winner.branch, msg);
    if (ctx.config.pushMain) {
        await pushBranch(ctx.paths.repoRoot, ctx.config.parentBranch);
    }
    await ctx.auditor.log("merge", {
        round: round.number,
        winner: winner.branch,
        sha: winner.sha,
        target: ctx.config.parentBranch,
        t1: winner.aggregates.t1,
        t2: winner.aggregates.t2,
        pushed: ctx.config.pushMain
    });
    return { outcome: "merged" };
}
