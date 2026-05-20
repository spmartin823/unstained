import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export interface SpawnOptions {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly logPath?: string;
}

export interface ProcessResult {
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly killed: boolean;
}

export interface RunningProcess {
    readonly pid: number;
    readonly result: Promise<ProcessResult>;
    readonly kill: (signal?: NodeJS.Signals) => void;
}

export function spawnLogged(
    cmd: string,
    args: ReadonlyArray<string>,
    opts: SpawnOptions
): RunningProcess {
    const env = { ...process.env, ...(opts.env ?? {}) };
    const child: ChildProcess = spawn(cmd, args as string[], {
        cwd: opts.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false
    });
    if (child.pid == null) {
        throw new Error(`spawn failed: ${cmd}`);
    }
    if (opts.logPath != null) {
        const out = createWriteStream(opts.logPath, { flags: "a" });
        child.stdout?.pipe(out, { end: false });
        child.stderr?.pipe(out, { end: false });
    }
    const result = new Promise<ProcessResult>((resolve) => {
        child.once("exit", (code, signal) => {
            resolve({ exitCode: code, signal, killed: child.killed });
        });
    });
    return {
        pid: child.pid,
        result,
        kill: (signal: NodeJS.Signals = "SIGTERM") => {
            try {
                child.kill(signal);
            } catch {
                /* already dead */
            }
        }
    };
}

export async function runCaptured(
    cmd: string,
    args: ReadonlyArray<string>,
    opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const env = { ...process.env, ...(opts.env ?? {}) };
    return new Promise((resolve) => {
        const child = spawn(cmd, args as string[], {
            cwd: opts.cwd,
            env,
            stdio: ["ignore", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });
        let timer: NodeJS.Timeout | null = null;
        if (opts.timeoutMs != null) {
            timer = setTimeout(() => {
                child.kill("SIGKILL");
            }, opts.timeoutMs);
        }
        child.once("exit", (code) => {
            if (timer != null) {
                clearTimeout(timer);
            }
            resolve({ exitCode: code, stdout, stderr });
        });
    });
}
