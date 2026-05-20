import { mkdir, readFile, rename, writeFile, appendFile, access } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
}

export async function writeJsonAtomic<T>(filePath: string, value: T): Promise<void> {
    await ensureDir(dirname(filePath));
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await rename(tmp, filePath);
}

export async function readJson<T>(filePath: string): Promise<T> {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
}

export async function readJsonOrNull<T>(filePath: string): Promise<T | null> {
    try {
        return await readJson<T>(filePath);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }
        throw err;
    }
}

export async function appendJsonl<T>(filePath: string, value: T): Promise<void> {
    await ensureDir(dirname(filePath));
    await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}
