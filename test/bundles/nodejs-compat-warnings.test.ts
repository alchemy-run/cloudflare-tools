/**
 * Tests that importing `node:*` without the `nodejs_compat` flag
 * produces a warning but does not fail the build.
 *
 * When `nodejs_compat` is not set, wrangler marks `node:*` imports as
 * external and warns that the worker may throw at runtime.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import { bundleWithEsbuild } from "../harness/esbuild-bundler.js";
import { loadFixture } from "../harness/fixture.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe("nodejs-compat-warnings", () => {
  let config: BundleConfig;

  it.beforeAll(async () => {
    config = await Effect.runPromise(loadFixture("nodejs-compat-warnings"));
  });

  describe.each([
    {
      name: "wrangler",
      bundler: bundleWithWrangler,
    },
    {
      name: "esbuild",
      bundler: bundleWithEsbuild,
    },
  ])("$name", ({ bundler }) => {
    let bundle: BundleResult;

    it.beforeAll(async () => {
      bundle = await Effect.runPromise(bundler(config));
    });

    it("builds successfully despite missing nodejs_compat flag", () => {
      expect(bundle.main).toBeTruthy();
      expect(bundle.type).toBe("esm");
    });

    it("preserves node:path as external import", async () => {
      const code = await fs.readFile(bundle.main, "utf-8");
      // Without nodejs_compat, node:path should be kept as an external import
      expect(code).toContain("node:path");
    });
  });
});
