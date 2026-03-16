/**
 * Tests that user-supplied `define` config correctly replaces identifiers.
 *
 * Workers can specify custom `define` entries in wrangler config to replace
 * top-level identifiers with constant values at build time. The bundler must
 * apply these alongside the default `process.env.NODE_ENV` replacement.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import { bundleWithEsbuild } from "../harness/esbuild-bundler.js";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe("custom-define", () => {
  let config: BundleConfig;

  it.beforeAll(async () => {
    config = await Effect.runPromise(loadFixture("custom-define"));
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

    it("builds successfully", () => {
      expect(bundle.main).toBeTruthy();
      expect(bundle.type).toBe("esm");
    });

    it("inlines MY_CONSTANT in output", async () => {
      const code = await fs.readFile(bundle.main, "utf-8");
      expect(code).toContain("hello-world");
    });

    it.effect("returns defined constant for /constant", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/constant");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("hello-world");
      }),
    );

    it.effect("returns defined version for /version", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/version");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("42");
      }),
    );

    it.effect("still replaces process.env.NODE_ENV alongside custom defines", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/node-env");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("production");
      }),
    );
  });
});
