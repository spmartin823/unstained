import { describe, expect, test } from "vitest";

import { checkAllowlist } from "../src/allowlist.js";

const DEFAULT_ALLOWLIST = [
    "generators/typescript/**",
    "generators/python/**",
    "packages/ir-sdk/fern/apis/ir-types-latest/**",
    "packages/ir-sdk/src/**",
    "packages/generator-migrations/src/generators/typescript/**",
    "packages/generator-migrations/src/generators/python/**",
    "pnpm-lock.yaml",
    "tournament/notes/**"
];

describe("checkAllowlist", () => {
    test("empty diff is allowed", () => {
        const result = checkAllowlist([], DEFAULT_ALLOWLIST);
        expect(result.ok).toBe(true);
        expect(result.violatingPaths).toEqual([]);
    });

    test("typescript generator edits are allowed", () => {
        const result = checkAllowlist(
            ["generators/typescript/sdk/src/ClientGenerator.ts", "generators/typescript/sdk/src/snippets.ts"],
            DEFAULT_ALLOWLIST
        );
        expect(result.ok).toBe(true);
    });

    test("python generator edits are allowed", () => {
        const result = checkAllowlist(["generators/python/sdk/src/foo.py"], DEFAULT_ALLOWLIST);
        expect(result.ok).toBe(true);
    });

    test("ir-types-latest edits are allowed", () => {
        const result = checkAllowlist(
            [
                "packages/ir-sdk/fern/apis/ir-types-latest/definition/types.yml",
                "packages/ir-sdk/fern/apis/ir-types-latest/VERSION",
                "packages/ir-sdk/fern/apis/ir-types-latest/changelog/CHANGELOG.md"
            ],
            DEFAULT_ALLOWLIST
        );
        expect(result.ok).toBe(true);
    });

    test("ir-sdk regenerated src is allowed", () => {
        const result = checkAllowlist(["packages/ir-sdk/src/sdk/api/types/Foo.ts"], DEFAULT_ALLOWLIST);
        expect(result.ok).toBe(true);
    });

    test("generator-migrations for typescript/python are allowed", () => {
        const result = checkAllowlist(
            [
                "packages/generator-migrations/src/generators/typescript/migrations/4.0.0.ts",
                "packages/generator-migrations/src/generators/python/migrations/3.0.0.ts"
            ],
            DEFAULT_ALLOWLIST
        );
        expect(result.ok).toBe(true);
    });

    test("pnpm-lock.yaml at root is allowed", () => {
        const result = checkAllowlist(["pnpm-lock.yaml"], DEFAULT_ALLOWLIST);
        expect(result.ok).toBe(true);
    });

    test("editing the eval submodule is rejected", () => {
        const result = checkAllowlist(["stainless-equivalency-eval/src/cli.ts"], DEFAULT_ALLOWLIST);
        expect(result.ok).toBe(false);
        expect(result.violatingPaths).toEqual(["stainless-equivalency-eval/src/cli.ts"]);
    });

    test("editing the CLI is rejected (out of allowlist)", () => {
        const result = checkAllowlist(
            ["packages/cli/cli/src/cli.ts", "packages/cli/configuration/src/foo.ts"],
            DEFAULT_ALLOWLIST
        );
        expect(result.ok).toBe(false);
        expect(result.violatingPaths.length).toBe(2);
    });

    test("editing test-definitions is rejected", () => {
        const result = checkAllowlist(["test-definitions/fern/apis/some/api.yml"], DEFAULT_ALLOWLIST);
        expect(result.ok).toBe(false);
    });

    test("editing CI workflows is rejected", () => {
        const result = checkAllowlist([".github/workflows/ci.yml"], DEFAULT_ALLOWLIST);
        expect(result.ok).toBe(false);
    });

    test("editing generator-migrations for non-tournament languages is rejected", () => {
        // Allowlist only covers typescript + python migration dirs.
        const result = checkAllowlist(
            ["packages/generator-migrations/src/generators/go/migrations/2.0.0.ts"],
            DEFAULT_ALLOWLIST
        );
        expect(result.ok).toBe(false);
    });

    test("mixed diff: some allowed, some not — collects all violators", () => {
        const result = checkAllowlist(
            [
                "generators/typescript/sdk/src/Foo.ts", // allowed
                "packages/cli/cli/src/cli.ts", // not allowed
                "pnpm-lock.yaml", // allowed
                ".github/workflows/ci.yml" // not allowed
            ],
            DEFAULT_ALLOWLIST
        );
        expect(result.ok).toBe(false);
        expect([...result.violatingPaths].sort()).toEqual(
            [".github/workflows/ci.yml", "packages/cli/cli/src/cli.ts"].sort()
        );
    });

    test("preserves diff order in violating paths", () => {
        const result = checkAllowlist(
            ["packages/cli/cli/src/foo.ts", "scripts/release.ts", "automation/sentry-triage/AGENT.md"],
            DEFAULT_ALLOWLIST
        );
        expect(result.ok).toBe(false);
        expect(result.violatingPaths).toEqual([
            "packages/cli/cli/src/foo.ts",
            "scripts/release.ts",
            "automation/sentry-triage/AGENT.md"
        ]);
    });

    test("works with an empty allowlist (rejects everything)", () => {
        const result = checkAllowlist(["generators/typescript/sdk/src/Foo.ts"], []);
        expect(result.ok).toBe(false);
        expect(result.violatingPaths).toEqual(["generators/typescript/sdk/src/Foo.ts"]);
    });

    test("does not allow path traversal escapes", () => {
        // A hostile worker tries to encode a path that resolves outside the allowlist.
        const result = checkAllowlist(
            ["generators/typescript/../../stainless-equivalency-eval/src/cli.ts"],
            DEFAULT_ALLOWLIST
        );
        expect(result.ok).toBe(false);
    });
});
