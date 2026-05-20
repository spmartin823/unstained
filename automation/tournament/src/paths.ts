import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { TournamentPaths } from "./types.js";

export interface ResolvePathsInput {
    readonly repoRoot: string;
    readonly runtimeRoot?: string;
    readonly worktreeRoot?: string;
    readonly claudeBinary?: string;
    readonly pnpmBinary?: string;
    readonly nodeBinaryDir?: string;
}

export function resolvePaths(input: ResolvePathsInput): TournamentPaths {
    const repoRoot = resolve(input.repoRoot);
    const runtimeRoot = input.runtimeRoot ?? join(repoRoot, "tournament");
    const worktreeRoot = input.worktreeRoot ?? join(dirname(repoRoot), "tournament-worktrees");
    const claudeBinary = input.claudeBinary ?? findClaudeBinary();
    const pnpmBinary = input.pnpmBinary ?? "pnpm";
    const nodeBinaryDir = input.nodeBinaryDir ?? findNodeBinaryDir();

    return {
        repoRoot,
        runtimeRoot,
        stateFile: join(runtimeRoot, "state.json"),
        auditFile: join(runtimeRoot, "audit.jsonl"),
        scoresDir: join(runtimeRoot, "scores"),
        logsDir: join(runtimeRoot, "logs"),
        worktreeRoot,
        promptPath: join(repoRoot, "automation/tournament/prompts/tournament-worker.md"),
        claudeBinary,
        pnpmBinary,
        nodeBinaryDir,
        evalSubmoduleDir: join(repoRoot, "stainless-equivalency-eval")
    };
}

function findClaudeBinary(): string {
    const candidates = [
        process.env.CLAUDE_BIN,
        "/Users/SeamusMartin1/.local/bin/claude",
        "/usr/local/bin/claude"
    ];
    for (const c of candidates) {
        if (c != null && c.length > 0 && isAbsolute(c) && existsSync(c)) {
            return c;
        }
    }
    return "claude";
}

function findNodeBinaryDir(): string {
    // Per saved feedback memory: Fern's husky pre-commit hook requires Node 24 on PATH,
    // otherwise the Node 20 corepack shim fails with "Cannot find matching keyid".
    const candidates = [
        process.env.TOURNAMENT_NODE_BIN_DIR,
        "/Users/SeamusMartin1/.nvm/versions/node/v24.15.0/bin"
    ];
    for (const c of candidates) {
        if (c != null && c.length > 0 && isAbsolute(c) && existsSync(c)) {
            return c;
        }
    }
    return dirname(process.execPath);
}
