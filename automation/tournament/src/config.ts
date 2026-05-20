import { readJson } from "./atomic-fs.js";
import type { TournamentConfig } from "./types.js";

const REQUIRED_KEYS: ReadonlyArray<keyof TournamentConfig> = [
    "roundDurationHours",
    "graceMinutes",
    "workersPerRound",
    "scorers",
    "dockerConcurrency",
    "tieEpsilon",
    "pushMain",
    "languages",
    "fixtures",
    "pathAllowlist",
    "workerBudgetUsd",
    "workerModel",
    "parentBranch",
    "roundLoopIntervalMs",
    "scoringPollIntervalMs",
    "maxRounds"
];

export async function loadConfig(configPath: string): Promise<TournamentConfig> {
    const raw = await readJson<Partial<TournamentConfig>>(configPath);
    for (const key of REQUIRED_KEYS) {
        if (!(key in raw)) {
            throw new Error(`tournament config ${configPath}: missing required key "${key}"`);
        }
    }
    return raw as TournamentConfig;
}

export function workerEnvFor(opts: {
    round: number;
    worker: string;
    deadlineIso: string;
    tournamentRoot: string;
}): string {
    return [
        `ROUND=${String(opts.round).padStart(2, "0")}`,
        `WORKER=${opts.worker}`,
        `DEADLINE=${opts.deadlineIso}`,
        `TOURNAMENT_ROOT=${opts.tournamentRoot}`,
        ""
    ].join("\n");
}
