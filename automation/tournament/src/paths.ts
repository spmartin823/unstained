import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { TournamentPaths } from "./types.js";

export interface ResolvePathsInput {
    readonly repoRoot?: string;
    readonly runtimeRoot?: string;
    readonly worktreeRoot?: string;
    readonly claudeBinary?: string;
    readonly pnpmBinary?: string;
    readonly nodeBinaryDir?: string;
}

export function findRepoRoot(startDir: string): string {
    // Walk up looking for the Fern repo root, identified by the combination of
    // pnpm-workspace.yaml + .gitmodules + automation/tournament/.
    let current = resolve(startDir);
    for (let i = 0; i < 16; i += 1) {
        if (
            existsSync(join(current, "pnpm-workspace.yaml")) &&
            existsSync(join(current, ".gitmodules")) &&
            existsSync(join(current, "automation", "tournament"))
        ) {
            return current;
        }
        const parent = dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    throw new Error(
        `could not find Fern repo root from ${startDir} (looking for pnpm-workspace.yaml + .gitmodules + automation/tournament). Set TOURNAMENT_REPO_ROOT to override.`
    );
}

export function resolvePaths(input: ResolvePathsInput): TournamentPaths {
    const repoRoot = resolve(input.repoRoot ?? findRepoRoot(process.cwd()));
    if (!isDirectory(repoRoot)) {
        throw new Error(`repoRoot ${repoRoot} is not a directory`);
    }
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

function isDirectory(p: string): boolean {
    try {
        return statSync(p).isDirectory();
    } catch {
        return false;
    }
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
