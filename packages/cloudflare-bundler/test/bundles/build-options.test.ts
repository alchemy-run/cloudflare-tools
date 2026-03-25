/**
 * Tests for build options: minification and keepNames.
 *
 * - `keepNames` (default: true) preserves function/class names via __name()
 * - `minify` reduces output size by removing whitespace and shortening identifiers
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import { outputPath } from "../harness/output.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";

describe("build-options", () => {
  let baseConfig: BundleConfig;

  it.beforeAll(async () => {
    baseConfig = await loadFixture("build-options");
  });

  describe("default (keepNames: true, no minify)", () => {
    let bundle: BundleResult;

    it.beforeAll(async () => {
      bundle = await Effect.runPromise(bundleWithRolldown(baseConfig));
    });

    it("builds successfully", () => {
      expect(bundle.main).toBeTruthy();
    });

    it("preserves function names by default (keepNames: true)", async () => {
      const code = await fs.readFile(outputPath(bundle), "utf-8");
      expect(code).toContain("myVeryLongAndDistinctiveFunctionName");
    });

    it.effect("function.name returns the original name", () =>
      withRunner({ bundle, config: baseConfig }, async (runner) => {
        const res = await runner.fetch("http://localhost/function-name");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("myVeryLongAndDistinctiveFunctionName");
      }),
    );

    it.effect("responds to fetch /", () =>
      withRunner({ bundle, config: baseConfig }, async (runner) => {
        const res = await runner.fetch("http://localhost/");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("ok");
      }),
    );
  });

  describe("minify: true", () => {
    let bundle: BundleResult;

    it.beforeAll(async () => {
      bundle = await Effect.runPromise(bundleWithRolldown({ ...baseConfig, minify: true }));
    });

    it("builds successfully", () => {
      expect(bundle.main).toBeTruthy();
    });

    it("produces minified output", async () => {
      const code = await fs.readFile(outputPath(bundle), "utf-8");
      const lines = code.split("\n").filter((line) => line.trim().length > 0);
      expect(lines.length).toBeLessThan(10);
    });

    it.effect("still runs correctly when minified", () =>
      withRunner({ bundle, config: baseConfig }, async (runner) => {
        const res = await runner.fetch("http://localhost/call");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("hello from named function");
      }),
    );
  });

  describe("keepNames: false", () => {
    let bundle: BundleResult;

    it.beforeAll(async () => {
      bundle = await Effect.runPromise(bundleWithRolldown({ ...baseConfig, keepNames: false }));
    });

    it("builds successfully", () => {
      expect(bundle.main).toBeTruthy();
    });

    it.effect("still runs when keepNames is disabled", () =>
      withRunner({ bundle, config: baseConfig }, async (runner) => {
        const res = await runner.fetch("http://localhost/call");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("hello from named function");
      }),
    );
  });
});
