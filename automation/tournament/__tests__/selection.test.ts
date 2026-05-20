import { describe, expect, test } from "vitest";

import { selectWinner } from "../src/selection.js";
import type { Score } from "../src/types.js";

function makeScore(opts: {
    sha: string;
    branch: string;
    scoredAt?: string;
    ete?: "pass" | "fail";
    guardViolation?: string | null;
    behavioral?: (number | null)[];
    signatureMean?: number;
    symbolMean?: number;
    fileMean?: number;
    structuralMean?: number;
}): Score {
    const behavioral = opts.behavioral ?? [null, null, null, null, null, null];
    const sig = opts.signatureMean ?? 0;
    const sym = opts.symbolMean ?? 0;
    const file = opts.fileMean ?? 0;
    const struct = opts.structuralMean ?? 0;
    const t1 = behavioral.reduce<number>((acc, v) => acc + (v ?? 0), 0) / behavioral.length;
    const t2 = sig * 0.5 + sym * 0.3 + file * 0.1 + struct * 0.1;
    return {
        sha: opts.sha,
        branch: opts.branch,
        scoredAt: opts.scoredAt ?? "2026-05-20T00:00:00Z",
        ete: opts.ete ?? "pass",
        guardViolation: opts.guardViolation ?? null,
        pairs: {},
        aggregates: {
            behavioralValues: behavioral,
            behavioralMean: t1,
            signatureMean: sig,
            symbolMean: sym,
            fileMean: file,
            structuralMean: struct,
            t1,
            t2
        }
    };
}

describe("selectWinner", () => {
    test("returns null when no scores at all", () => {
        const result = selectWinner([], 0.005);
        expect(result.winner).toBeNull();
        expect(result.reason).toBe("no_candidates");
    });

    test("returns null when every candidate is DQ'd by ETE fail", () => {
        const scores = [
            makeScore({ sha: "a", branch: "tournament/r01/w01", ete: "fail" }),
            makeScore({ sha: "b", branch: "tournament/r01/w02", ete: "fail" })
        ];
        const result = selectWinner(scores, 0.005);
        expect(result.winner).toBeNull();
        expect(result.reason).toBe("no_candidates");
        expect(result.disqualified.map((d) => d.branch).sort()).toEqual(["tournament/r01/w01", "tournament/r01/w02"]);
    });

    test("DQs guard violations independent of fitness", () => {
        const scores = [
            makeScore({
                sha: "a",
                branch: "tournament/r01/w01",
                guardViolation: "edited stainless-equivalency-eval/src/cli.ts",
                behavioral: [1, 1, 1, 1, 1, 1] // would be best if not DQ'd
            }),
            makeScore({
                sha: "b",
                branch: "tournament/r01/w02",
                behavioral: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2]
            })
        ];
        const result = selectWinner(scores, 0.005);
        expect(result.winner?.branch).toBe("tournament/r01/w02");
        expect(result.disqualified.map((d) => d.branch)).toContain("tournament/r01/w01");
    });

    test("picks single tier 1 winner when behavioral mean is clearly highest", () => {
        const scores = [
            makeScore({ sha: "a", branch: "tournament/r01/w01", behavioral: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1] }),
            makeScore({ sha: "b", branch: "tournament/r01/w02", behavioral: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5] }),
            makeScore({ sha: "c", branch: "tournament/r01/w03", behavioral: [0.3, 0.3, 0.3, 0.3, 0.3, 0.3] })
        ];
        const result = selectWinner(scores, 0.005);
        expect(result.winner?.branch).toBe("tournament/r01/w02");
        expect(result.reason).toBe("tier1_single_winner");
    });

    test("treats null behavioral entries as zero in tier 1 mean", () => {
        const scores = [
            makeScore({ sha: "a", branch: "tournament/r01/w01", behavioral: [1.0, null, null, null, null, null] }),
            makeScore({
                sha: "b",
                branch: "tournament/r01/w02",
                behavioral: [0.5, 0.5, 0.5, 0.5, null, null]
            })
        ];
        // a: 1.0/6 ≈ 0.167; b: 2.0/6 ≈ 0.333. b wins.
        const result = selectWinner(scores, 0.005);
        expect(result.winner?.branch).toBe("tournament/r01/w02");
    });

    test("falls through to tier 2 when tier 1 is tied within epsilon", () => {
        const scores = [
            makeScore({
                sha: "a",
                branch: "tournament/r01/w01",
                behavioral: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
                signatureMean: 0.5,
                symbolMean: 0.5
            }),
            makeScore({
                sha: "b",
                branch: "tournament/r01/w02",
                behavioral: [0.5, 0.5, 0.5, 0.5, 0.5, 0.502],
                signatureMean: 0.9,
                symbolMean: 0.9
            })
        ];
        // Tier 1: a=0.5, b=0.5003, |diff|=0.0003 < epsilon — tied.
        // Tier 2: a=(.5*.5+.5*.3)=0.4, b=(.9*.5+.9*.3)=0.72. b wins.
        const result = selectWinner(scores, 0.005);
        expect(result.winner?.branch).toBe("tournament/r01/w02");
        expect(result.reason).toBe("tier2_tiebreak");
    });

    test("falls through to tier 3 (timestamp) when tier 1 AND tier 2 are tied", () => {
        const scores = [
            makeScore({
                sha: "a",
                branch: "tournament/r01/w01",
                scoredAt: "2026-05-20T02:00:00Z",
                behavioral: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
                signatureMean: 0.5,
                symbolMean: 0.5
            }),
            makeScore({
                sha: "b",
                branch: "tournament/r01/w02",
                scoredAt: "2026-05-20T01:00:00Z", // earlier
                behavioral: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
                signatureMean: 0.5,
                symbolMean: 0.5
            })
        ];
        const result = selectWinner(scores, 0.005);
        expect(result.winner?.branch).toBe("tournament/r01/w02"); // earlier scoredAt wins
        expect(result.reason).toBe("tier3_timestamp");
    });

    test("round 1 typical case: everyone tier 1 zero, tier 2 decides", () => {
        // Realistic: nobody has unlocked behavioral yet; all-null behavioral
        const scores = [
            makeScore({
                sha: "a",
                branch: "tournament/r01/w01",
                signatureMean: 0.3,
                symbolMean: 0.4
            }),
            makeScore({
                sha: "b",
                branch: "tournament/r01/w02",
                signatureMean: 0.5,
                symbolMean: 0.5,
                fileMean: 0.8
            }),
            makeScore({
                sha: "c",
                branch: "tournament/r01/w03",
                signatureMean: 0.2
            })
        ];
        const result = selectWinner(scores, 0.005);
        expect(result.winner?.branch).toBe("tournament/r01/w02");
        expect(result.reason).toBe("tier2_tiebreak");
    });

    test("respects custom epsilon for tier 1 tie band", () => {
        const scores = [
            makeScore({
                sha: "a",
                branch: "tournament/r01/w01",
                behavioral: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
                signatureMean: 0.1
            }),
            makeScore({
                sha: "b",
                branch: "tournament/r01/w02",
                behavioral: [0.6, 0.6, 0.6, 0.6, 0.6, 0.6], // tier1 = 0.6
                signatureMean: 0.9
            })
        ];
        // Wide epsilon: 0.5 vs 0.6 differ by 0.1 < 0.2 → tied → tier 2 (b wins on sig)
        const wide = selectWinner(scores, 0.2);
        expect(wide.winner?.branch).toBe("tournament/r01/w02");
        expect(wide.reason).toBe("tier2_tiebreak");
        // Narrow epsilon: not tied → tier 1 picks b
        const narrow = selectWinner(scores, 0.001);
        expect(narrow.winner?.branch).toBe("tournament/r01/w02");
        expect(narrow.reason).toBe("tier1_single_winner");
    });
});
