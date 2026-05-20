export class Semaphore {
    private readonly waiters: Array<() => void> = [];
    private available: number;

    constructor(capacity: number) {
        if (capacity < 1) {
            throw new Error(`Semaphore capacity must be >= 1, got ${capacity}`);
        }
        this.available = capacity;
    }

    async acquire(): Promise<void> {
        if (this.available > 0) {
            this.available -= 1;
            return;
        }
        await new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    release(): void {
        const next = this.waiters.shift();
        if (next != null) {
            next();
            return;
        }
        this.available += 1;
    }

    async withPermit<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
            reject(new Error("aborted"));
            return;
        }
        const t = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(t);
            reject(new Error("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
