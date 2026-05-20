export type Language = "typescript" | "python";

export type EteOutcome = "pass" | "fail";

export interface EvalPairScorecard {
    readonly behavioral: number | null;
    readonly signatureParity: number | null;
    readonly symbolCoverage: number | null;
    readonly fileCoverage: number | null;
    readonly structural: number | null;
    readonly composite: number | null;
}

export interface ScoreAggregates {
    readonly behavioralValues: ReadonlyArray<number | null>;
    readonly behavioralMean: number;
    readonly signatureMean: number;
    readonly symbolMean: number;
    readonly fileMean: number;
    readonly structuralMean: number;
    readonly t1: number;
    readonly t2: number;
}

export interface Score {
    readonly sha: string;
    readonly branch: string;
    readonly scoredAt: string;
    readonly ete: EteOutcome;
    readonly guardViolation: string | null;
    readonly pairs: Readonly<Record<string, EvalPairScorecard>>;
    readonly aggregates: ScoreAggregates;
}

export type SelectionReason = "no_candidates" | "tier1_single_winner" | "tier2_tiebreak" | "tier3_timestamp";

export interface SelectionDisqualification {
    readonly branch: string;
    readonly sha: string;
    readonly reason: "ete_fail" | "guard_violation";
    readonly detail?: string;
}

export interface SelectionResult {
    readonly winner: Score | null;
    readonly reason: SelectionReason;
    readonly disqualified: ReadonlyArray<SelectionDisqualification>;
}

export interface AllowlistCheckResult {
    readonly ok: boolean;
    readonly violatingPaths: ReadonlyArray<string>;
}

export interface TournamentConfig {
    readonly roundDurationHours: number;
    readonly graceMinutes: number;
    readonly workersPerRound: number;
    readonly scorers: number;
    readonly dockerConcurrency: number;
    readonly tieEpsilon: number;
    readonly pushMain: boolean;
    readonly languages: ReadonlyArray<Language>;
    readonly fixtures: ReadonlyArray<string>;
    readonly pathAllowlist: ReadonlyArray<string>;
    readonly workerBudgetUsd: number;
    readonly workerModel: string;
    readonly parentBranch: string;
    readonly roundLoopIntervalMs: number;
    readonly scoringPollIntervalMs: number;
    readonly maxRounds: number | null;
    readonly skipEte: boolean;
}

export interface TournamentPaths {
    readonly repoRoot: string;
    readonly runtimeRoot: string;
    readonly stateFile: string;
    readonly auditFile: string;
    readonly scoresDir: string;
    readonly logsDir: string;
    readonly worktreeRoot: string;
    readonly promptPath: string;
    readonly claudeBinary: string;
    readonly pnpmBinary: string;
    readonly nodeBinaryDir: string;
    readonly evalSubmoduleDir: string;
}

export interface WorkerState {
    readonly id: string;
    readonly branch: string;
    readonly worktree: string;
    readonly pid: number | null;
    readonly log: string;
    readonly startedAt: string;
}

export interface RoundState {
    readonly number: number;
    readonly startedAt: string;
    readonly deadline: string;
    readonly workers: ReadonlyArray<WorkerState>;
}

export interface RoundOutcome {
    readonly round: number;
    readonly winner: {
        readonly branch: string;
        readonly sha: string;
        readonly t1: number;
        readonly t2: number;
    } | null;
    readonly outcome: "merged" | "pr" | "no_winner";
    readonly completedAt: string;
}

export interface TournamentState {
    readonly tournamentId: string;
    readonly currentRound: RoundState | null;
    readonly history: ReadonlyArray<RoundOutcome>;
}
