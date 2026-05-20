/*
 * Pre-flight checks. Run with:
 *   tsx automation/tournament/src/preflight.ts [configPath]
 *
 * Validates the environment without spawning workers or running a tournament:
 *  - tournament config parses
 *  - claude binary exists and reports a version
 *  - pnpm is on PATH
 *  - git is on PATH
 *  - we're inside a git working tree
 *  - the parent branch exists
 *  - the eval submodule directory exists and is initialized
 *  - the eval CLI is invokable
 *  - the worktree root is writable
 *
 * Exits 0 on success, non-zero with a list of issues otherwise.
 */

import { access, constants, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { loadConfig } from "./config.js";
import { ensureRefExists } from "./git.js";
import { resolvePaths } from "./paths.js";
import { runCaptured } from "./spawn.js";

interface Check {
    readonly name: string;
    readonly run: () => Promise<{ ok: boolean; detail: string }>;
}

export async function runPreflight(configPath: string): Promise<{ ok: boolean; issues: string[] }> {
    const issues: string[] = [];

    const cfgResult = await tryAsync(() => loadConfig(configPath));
    if (!cfgResult.ok) {
        issues.push(`config: ${cfgResult.error}`);
        return { ok: false, issues };
    }
    const config = cfgResult.value;
    let paths;
    try {
        paths = resolvePaths({ repoRoot: process.env.TOURNAMENT_REPO_ROOT });
    } catch (err) {
        issues.push((err as Error).message);
        return { ok: false, issues };
    }

    const checks: Check[] = [
        {
            name: "claude binary",
            run: async () => {
                const res = await runCaptured(paths.claudeBinary, ["--version"], {
                    cwd: paths.repoRoot,
                    timeoutMs: 10_000
                });
                if (res.exitCode === 0) {
                    return { ok: true, detail: `${paths.claudeBinary} -> ${res.stdout.trim()}` };
                }
                return {
                    ok: false,
                    detail: `${paths.claudeBinary} --version failed (exit ${res.exitCode}): ${res.stderr.trim()}`
                };
            }
        },
        {
            name: "pnpm on PATH",
            run: async () => {
                const res = await runCaptured(paths.pnpmBinary, ["--version"], {
                    cwd: paths.repoRoot,
                    env: { PATH: `${paths.nodeBinaryDir}:${process.env.PATH ?? ""}` },
                    timeoutMs: 10_000
                });
                return res.exitCode === 0
                    ? { ok: true, detail: res.stdout.trim() }
                    : { ok: false, detail: `pnpm --version failed: ${res.stderr.trim()}` };
            }
        },
        {
            name: "git on PATH",
            run: async () => {
                const res = await runCaptured("git", ["--version"], { cwd: paths.repoRoot });
                return res.exitCode === 0
                    ? { ok: true, detail: res.stdout.trim() }
                    : { ok: false, detail: `git --version failed: ${res.stderr.trim()}` };
            }
        },
        {
            name: "git working tree",
            run: async () => {
                const res = await runCaptured(
                    "git",
                    ["rev-parse", "--is-inside-work-tree"],
                    { cwd: paths.repoRoot }
                );
                return res.exitCode === 0
                    ? { ok: true, detail: res.stdout.trim() }
                    : { ok: false, detail: `not inside a git tree at ${paths.repoRoot}` };
            }
        },
        {
            name: `parent branch '${config.parentBranch}' exists`,
            run: async () => {
                const exists = await ensureRefExists(paths.repoRoot, config.parentBranch);
                return exists
                    ? { ok: true, detail: config.parentBranch }
                    : { ok: false, detail: `ref ${config.parentBranch} not found` };
            }
        },
        {
            name: "eval submodule initialized",
            run: async () => {
                try {
                    await access(paths.evalSubmoduleDir, constants.R_OK);
                } catch {
                    return { ok: false, detail: `${paths.evalSubmoduleDir} not accessible` };
                }
                try {
                    await access(`${paths.evalSubmoduleDir}/src/cli.ts`, constants.R_OK);
                    return { ok: true, detail: paths.evalSubmoduleDir };
                } catch {
                    return {
                        ok: false,
                        detail: `${paths.evalSubmoduleDir}/src/cli.ts not found — submodule probably not checked out (try: git submodule update --init --recursive)`
                    };
                }
            }
        },
        {
            name: "worktree root creatable",
            run: async () => {
                try {
                    await mkdir(paths.worktreeRoot, { recursive: true });
                    await access(paths.worktreeRoot, constants.W_OK);
                    return { ok: true, detail: paths.worktreeRoot };
                } catch {
                    return {
                        ok: false,
                        detail: `cannot create or write to ${paths.worktreeRoot} (parent dir ${dirname(paths.worktreeRoot)} may not exist or be writable)`
                    };
                }
            }
        }
    ];

    for (const check of checks) {
        const r = await check.run();
        const sign = r.ok ? "✓" : "✗";
        console.log(`  ${sign} ${check.name}: ${r.detail}`);
        if (!r.ok) {
            issues.push(`${check.name}: ${r.detail}`);
        }
    }

    return { ok: issues.length === 0, issues };
}

async function tryAsync<T>(
    fn: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    try {
        return { ok: true, value: await fn() };
    } catch (err) {
        return { ok: false, error: (err as Error).message };
    }
}

const invokedDirectly = (() => {
    const argv1 = process.argv[1];
    if (argv1 == null) {
        return false;
    }
    return argv1.endsWith("preflight.ts") || argv1.endsWith("preflight.js");
})();

if (invokedDirectly) {
    const configPath = process.argv[2] ?? "automation/tournament/config.json";
    console.log(`[preflight] checking tournament configuration at ${configPath}`);
    runPreflight(configPath)
        .then((result) => {
            if (result.ok) {
                console.log("[preflight] all checks passed");
                process.exit(0);
            } else {
                console.error(`[preflight] ${result.issues.length} issue(s) detected; refusing to start`);
                process.exit(1);
            }
        })
        .catch((err: unknown) => {
            console.error("[preflight] error:", err);
            process.exit(2);
        });
}
