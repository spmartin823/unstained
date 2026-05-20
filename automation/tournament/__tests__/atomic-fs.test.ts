import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { appendJsonl, fileExists, readJson, readJsonOrNull, writeJsonAtomic } from "../src/atomic-fs.js";

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tournament-atomic-fs-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("writeJsonAtomic + readJson", () => {
    test("writes and reads JSON roundtrip", async () => {
        const filePath = join(root, "data.json");
        await writeJsonAtomic(filePath, { foo: "bar", n: 42 });
        const read = await readJson<{ foo: string; n: number }>(filePath);
        expect(read).toEqual({ foo: "bar", n: 42 });
    });

    test("creates parent directories", async () => {
        const filePath = join(root, "deeply", "nested", "data.json");
        await writeJsonAtomic(filePath, { x: 1 });
        expect(await fileExists(filePath)).toBe(true);
    });

    test("does not leave temp files on success", async () => {
        const filePath = join(root, "data.json");
        await writeJsonAtomic(filePath, { x: 1 });
        const entries = (await import("node:fs/promises")).readdir(root);
        const names = await entries;
        expect(names).toEqual(["data.json"]);
    });

    test("atomic: a partial reader sees old content until rename", async () => {
        const filePath = join(root, "data.json");
        await writeJsonAtomic(filePath, { v: 1 });
        const before = await readFile(filePath, "utf8");
        await writeJsonAtomic(filePath, { v: 2 });
        const after = await readFile(filePath, "utf8");
        expect(JSON.parse(before)).toEqual({ v: 1 });
        expect(JSON.parse(after)).toEqual({ v: 2 });
    });
});

describe("readJsonOrNull", () => {
    test("returns null for missing file", async () => {
        const result = await readJsonOrNull(join(root, "nope.json"));
        expect(result).toBeNull();
    });

    test("returns parsed JSON when file exists", async () => {
        const filePath = join(root, "exists.json");
        await writeJsonAtomic(filePath, { hello: "world" });
        const result = await readJsonOrNull<{ hello: string }>(filePath);
        expect(result).toEqual({ hello: "world" });
    });

    test("throws on non-ENOENT errors (e.g. invalid JSON)", async () => {
        const filePath = join(root, "bad.json");
        await (await import("node:fs/promises")).writeFile(filePath, "{not json", "utf8");
        await expect(readJsonOrNull(filePath)).rejects.toThrow();
    });
});

describe("appendJsonl", () => {
    test("appends each call as a JSON line", async () => {
        const filePath = join(root, "events.jsonl");
        await appendJsonl(filePath, { ev: "a", n: 1 });
        await appendJsonl(filePath, { ev: "b", n: 2 });
        await appendJsonl(filePath, { ev: "c", n: 3 });
        const content = await readFile(filePath, "utf8");
        const lines = content.split("\n").filter((l) => l.length > 0);
        expect(lines).toHaveLength(3);
        expect(JSON.parse(lines[0]!)).toEqual({ ev: "a", n: 1 });
        expect(JSON.parse(lines[2]!)).toEqual({ ev: "c", n: 3 });
    });

    test("creates parent directories", async () => {
        const filePath = join(root, "nested", "audit.jsonl");
        await appendJsonl(filePath, { ev: "first" });
        expect(await fileExists(filePath)).toBe(true);
    });
});

describe("fileExists", () => {
    test("true for existing file", async () => {
        const filePath = join(root, "exists.json");
        await writeJsonAtomic(filePath, {});
        expect(await fileExists(filePath)).toBe(true);
    });

    test("false for missing file", async () => {
        expect(await fileExists(join(root, "nope"))).toBe(false);
    });
});
