/**
 * Tests that service-worker format (IIFE) output is supported.
 *
 * Workers without a default export are treated as service-worker format.
 * The bundler should output IIFE format instead of ESM, and the output
 * should not contain export statements.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import { bundleWithEsbuild } from "../harness/esbuild-bundler.js";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe("service-worker", () => {
  let baseConfig: BundleConfig;

  it.beforeAll(async () => {
    baseConfig = await Effect.runPromise(loadFixture("service-worker"));
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
      const config = { ...baseConfig, format: "service-worker" as const };
      bundle = await Effect.runPromise(bundler(config));
    });

    it("builds successfully", () => {
      expect(bundle.main).toBeTruthy();
    });

    it("detects service-worker (non-ESM) format", () => {
      expect(bundle.type).toBe("commonjs");
    });

    it("output does not contain export statements", async () => {
      const code = await fs.readFile(bundle.main, "utf-8");
      expect(code).not.toMatch(/\bexport\s/);
    });

    it.effect("responds to fetch /", () =>
      withRunner({ bundle, config: baseConfig }, async (runner) => {
        const res = await runner.fetch("http://localhost/");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("ok");
      }),
    );

    it.effect("responds to fetch /hello", () =>
      withRunner({ bundle, config: baseConfig }, async (runner) => {
        const res = await runner.fetch("http://localhost/hello");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("hello from service worker");
      }),
    );
  });
});
