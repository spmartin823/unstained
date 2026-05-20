import { describe, expect, test } from "vitest";

import { Semaphore, sleep } from "../src/concurrency.js";

describe("Semaphore", () => {
    test("allows up to capacity concurrent acquires without blocking", async () => {
        const sem = new Semaphore(2);
        await sem.acquire();
        await sem.acquire();
        // Third acquire would block; assert by Promise.race against a tiny sleep.
        const acquired = await Promise.race([
            sem.acquire().then(() => "acquired" as const),
            sleep(20).then(() => "timeout" as const)
        ]);
        expect(acquired).toBe("timeout");
    });

    test("release lets a waiter proceed", async () => {
        const sem = new Semaphore(1);
        await sem.acquire();
        let waiterDone = false;
        const waiter = sem.acquire().then(() => {
            waiterDone = true;
        });
        await sleep(10);
        expect(waiterDone).toBe(false);
        sem.release();
        await waiter;
        expect(waiterDone).toBe(true);
    });

    test("withPermit releases even if fn throws", async () => {
        const sem = new Semaphore(1);
        await expect(
            sem.withPermit(async () => {
                throw new Error("boom");
            })
        ).rejects.toThrow("boom");
        // Should still be able to acquire — no leaked permit.
        await sem.acquire();
    });

    test("withPermit returns fn result", async () => {
        const sem = new Semaphore(1);
        const result = await sem.withPermit(async () => 42);
        expect(result).toBe(42);
    });

    test("rejects capacity < 1", () => {
        expect(() => new Semaphore(0)).toThrow();
        expect(() => new Semaphore(-1)).toThrow();
    });
});

describe("sleep", () => {
    test("resolves after roughly the given duration", async () => {
        const start = Date.now();
        await sleep(50);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(40);
        expect(elapsed).toBeLessThan(200);
    });

    test("rejects on abort", async () => {
        const ac = new AbortController();
        const p = sleep(1000, ac.signal);
        ac.abort();
        await expect(p).rejects.toThrow("aborted");
    });

    test("rejects immediately if signal already aborted", async () => {
        const ac = new AbortController();
        ac.abort();
        await expect(sleep(1000, ac.signal)).rejects.toThrow("aborted");
    });
});
