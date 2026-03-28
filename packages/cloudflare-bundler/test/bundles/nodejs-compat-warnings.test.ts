/**
 * Tests that importing `node:*` without the `nodejs_compat` flag
 * produces a warning but does not fail the build.
 *
 * When `nodejs_compat` is not set, wrangler marks `node:*` imports as
 * external and warns that the worker may throw at runtime.
 */
import { beforeAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import { loadFixture } from "../harness/fixture.js";
import { outputPath } from "../harness/output.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe.concurrent("nodejs-compat-warnings", () => {
  let config: BundleConfig;

  beforeAll(async () => {
    config = await loadFixture("nodejs-compat-warnings");
  });

  describe.each([
    { name: "wrangler", fn: bundleWithWrangler },
    { name: "rolldown", fn: bundleWithRolldown },
  ])("$name", ({ fn }) => {
    let bundle: BundleResult;

    it.beforeAll(async () => {
      bundle = await Effect.runPromise(fn(config));
    });

    it("builds successfully despite missing nodejs_compat flag", () => {
      expect(bundle.main).toBeTruthy();
    });

    it("preserves node:path as external import", async () => {
      const code = await fs.readFile(outputPath(bundle), "utf-8");
      expect(code).toContain("node:path");
    });

    if (fn === bundleWithRolldown) {
      it("collects a nodejs_compat warning", () => {
        expect(bundle.warnings).toEqual([
          "Node.js built-ins were imported without `nodejs_compat`: node:path",
        ]);
      });
    }
  });
});
