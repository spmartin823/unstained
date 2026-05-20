import type { Score, SelectionDisqualification, SelectionReason, SelectionResult } from "./types.js";

interface CandidateWithRanking {
    readonly score: Score;
    readonly t1: number;
    readonly t2: number;
}

function meanWithNullAsZero(values: ReadonlyArray<number | null>): number {
    if (values.length === 0) {
        return 0;
    }
    let sum = 0;
    for (const v of values) {
        sum += v ?? 0;
    }
    return sum / values.length;
}

function tier2Score(score: Score): number {
    const { signatureMean, symbolMean, fileMean, structuralMean } = score.aggregates;
    return signatureMean * 0.5 + symbolMean * 0.3 + fileMean * 0.1 + structuralMean * 0.1;
}

export function selectWinner(scores: ReadonlyArray<Score>, tieEpsilon: number): SelectionResult {
    const disqualified: SelectionDisqualification[] = [];
    const candidates: CandidateWithRanking[] = [];

    for (const score of scores) {
        if (score.guardViolation != null) {
            disqualified.push({
                branch: score.branch,
                sha: score.sha,
                reason: "guard_violation",
                detail: score.guardViolation
            });
            continue;
        }
        if (score.ete === "fail") {
            disqualified.push({
                branch: score.branch,
                sha: score.sha,
                reason: "ete_fail"
            });
            continue;
        }
        candidates.push({
            score,
            t1: meanWithNullAsZero(score.aggregates.behavioralValues),
            t2: tier2Score(score)
        });
    }

    if (candidates.length === 0) {
        return {
            winner: null,
            reason: "no_candidates",
            disqualified
        };
    }

    candidates.sort((a, b) => b.t1 - a.t1);
    const topT1 = candidates[0]!.t1;
    const tier1 = candidates.filter((c) => c.t1 >= topT1 - tieEpsilon);

    if (tier1.length === 1) {
        return result(tier1[0]!.score, "tier1_single_winner", disqualified);
    }

    tier1.sort((a, b) => b.t2 - a.t2);
    const topT2 = tier1[0]!.t2;
    const tier2 = tier1.filter((c) => c.t2 >= topT2 - tieEpsilon);

    if (tier2.length === 1) {
        return result(tier2[0]!.score, "tier2_tiebreak", disqualified);
    }

    const byTimestamp = [...tier2].sort((a, b) => a.score.scoredAt.localeCompare(b.score.scoredAt));
    return result(byTimestamp[0]!.score, "tier3_timestamp", disqualified);
}

function result(
    winner: Score,
    reason: SelectionReason,
    disqualified: ReadonlyArray<SelectionDisqualification>
): SelectionResult {
    return { winner, reason, disqualified };
}
