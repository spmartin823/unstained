import { runCaptured } from "./spawn.js";

const GIT = "git";

export interface GitError extends Error {
    readonly exitCode: number;
    readonly stderr: string;
}

function gitError(args: ReadonlyArray<string>, exitCode: number, stderr: string): GitError {
    const err = new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`) as GitError;
    Object.assign(err, { exitCode, stderr });
    return err;
}

async function git(
    repoRoot: string,
    args: ReadonlyArray<string>
): Promise<{ stdout: string; stderr: string }> {
    const res = await runCaptured(GIT, args, { cwd: repoRoot });
    if (res.exitCode !== 0) {
        throw gitError(args, res.exitCode ?? -1, res.stderr);
    }
    return { stdout: res.stdout, stderr: res.stderr };
}

export async function revParse(repoRoot: string, ref: string): Promise<string> {
    const { stdout } = await git(repoRoot, ["rev-parse", ref]);
    return stdout.trim();
}

export async function diffNameOnly(
    repoRoot: string,
    baseRef: string,
    headRef: string
): Promise<ReadonlyArray<string>> {
    const { stdout } = await git(repoRoot, ["diff", "--name-only", `${baseRef}..${headRef}`]);
    return stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

export async function worktreeAdd(
    repoRoot: string,
    worktreePath: string,
    branch: string,
    fromRef: string
): Promise<void> {
    await git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, fromRef]);
}

export async function worktreeRemove(repoRoot: string, worktreePath: string): Promise<void> {
    try {
        await git(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    } catch (err) {
        // If the worktree is already gone, prune to clean up the admin file.
        const ge = err as GitError;
        if (!/not a working tree/i.test(ge.stderr ?? "")) {
            throw err;
        }
        await git(repoRoot, ["worktree", "prune"]);
    }
}

export async function branchDelete(repoRoot: string, branch: string): Promise<void> {
    await git(repoRoot, ["branch", "-D", branch]);
}

export async function checkoutBranch(repoRoot: string, branch: string): Promise<void> {
    await git(repoRoot, ["checkout", branch]);
}

export async function mergeNoFf(
    repoRoot: string,
    branch: string,
    message: string
): Promise<void> {
    await git(repoRoot, ["merge", "--no-ff", branch, "-m", message]);
}

export async function pushBranch(
    repoRoot: string,
    branch: string,
    remoteBranch?: string
): Promise<void> {
    const refspec = remoteBranch == null ? branch : `${branch}:${remoteBranch}`;
    await git(repoRoot, ["push", "origin", refspec]);
}

export async function listWorktrees(repoRoot: string): Promise<ReadonlyArray<string>> {
    const { stdout } = await git(repoRoot, ["worktree", "list", "--porcelain"]);
    const paths: string[] = [];
    for (const line of stdout.split("\n")) {
        if (line.startsWith("worktree ")) {
            paths.push(line.slice("worktree ".length).trim());
        }
    }
    return paths;
}

export async function ensureRefExists(repoRoot: string, ref: string): Promise<boolean> {
    try {
        await git(repoRoot, ["rev-parse", "--verify", ref]);
        return true;
    } catch {
        return false;
    }
}

export async function configEvalSubmoduleIsClean(
    repoRoot: string,
    baseRef: string,
    headRef: string
): Promise<string | null> {
    const changed = await diffNameOnly(repoRoot, baseRef, headRef);
    const violator = changed.find(
        (p) => p === "stainless-equivalency-eval" || p.startsWith("stainless-equivalency-eval/")
    );
    return violator ?? null;
}
