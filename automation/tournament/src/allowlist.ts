import { minimatch } from "minimatch";

import type { AllowlistCheckResult } from "./types.js";

export function checkAllowlist(
    changedPaths: ReadonlyArray<string>,
    allowlist: ReadonlyArray<string>
): AllowlistCheckResult {
    const violatingPaths: string[] = [];
    for (const path of changedPaths) {
        if (!isAllowed(path, allowlist)) {
            violatingPaths.push(path);
        }
    }
    return {
        ok: violatingPaths.length === 0,
        violatingPaths
    };
}

function isAllowed(path: string, allowlist: ReadonlyArray<string>): boolean {
    if (containsPathEscape(path)) {
        return false;
    }
    for (const pattern of allowlist) {
        if (minimatch(path, pattern, { dot: true })) {
            return true;
        }
    }
    return false;
}

function containsPathEscape(path: string): boolean {
    if (path.startsWith("/")) {
        return true;
    }
    const segments = path.split("/");
    return segments.includes("..");
}
