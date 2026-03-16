/**
 * Tests for build options: minification and keepNames.
 *
 * - `keepNames` (default: true) preserves function/class names via __name()
 * - `minify` reduces output size by removing whitespace and shortening identifiers
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import { bundleWithEsbuild } from "../harness/esbuild-bundler.js";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe("build-options", () => {
  let baseConfig: BundleConfig;

  it.beforeAll(async () => {
    baseConfig = await Effect.runPromise(loadFixture("build-options"));
  });

  describe("default (keepNames: true, no minify)", () => {
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
        bundle = await Effect.runPromise(bundler(baseConfig));
      });

      it("builds successfully", () => {
        expect(bundle.main).toBeTruthy();
        expect(bundle.type).toBe("esm");
      });

      it("preserves function names by default (keepNames: true)", async () => {
        const code = await fs.readFile(bundle.main, "utf-8");
        // esbuild's keepNames wraps functions with __name() to preserve .name
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
  });

  describe("minify: true", () => {
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
        const minifyConfig = { ...baseConfig, minify: true };
        bundle = await Effect.runPromise(bundler(minifyConfig));
      });

      it("builds successfully", () => {
        expect(bundle.main).toBeTruthy();
        expect(bundle.type).toBe("esm");
      });

      it("produces minified output", async () => {
        const code = await fs.readFile(bundle.main, "utf-8");
        // Minified code should not have the verbose function name as a plain identifier
        // (it may still appear in a __name() call for keepNames, but the function
        // identifier itself should be shortened)
        // A simple heuristic: minified output has fewer newlines
        const lines = code.split("\n").filter((l) => l.trim().length > 0);
        // Minified ESM typically compresses to very few lines
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
  });

  describe("keepNames: false", () => {
    describe.each([
      {
        name: "esbuild",
        bundler: bundleWithEsbuild,
      },
    ])("$name", ({ bundler }) => {
      let bundle: BundleResult;

      it.beforeAll(async () => {
        const noKeepNamesConfig = { ...baseConfig, keepNames: false };
        bundle = await Effect.runPromise(bundler(noKeepNamesConfig));
      });

      it("builds successfully", () => {
        expect(bundle.main).toBeTruthy();
        expect(bundle.type).toBe("esm");
      });

      it("does not add __name() wrappers", async () => {
        const code = await fs.readFile(bundle.main, "utf-8");
        expect(code).not.toContain("__name(");
      });
    });
  });
});
