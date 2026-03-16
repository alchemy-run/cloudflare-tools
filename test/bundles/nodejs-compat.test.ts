/**
 * Tests that Node.js polyfills are correctly applied via unenv.
 *
 * Workers with `nodejs_compat` compatibility flag should have Node.js
 * built-in modules polyfilled or aliased through unenv and the
 * @cloudflare/unenv-preset. This includes:
 * - crypto.getRandomValues
 * - Buffer from node:buffer
 * - process global
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { bundleWithEsbuild } from "../harness/esbuild-bundler.js";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe("nodejs-compat", () => {
  let config: BundleConfig;

  it.beforeAll(async () => {
    config = await Effect.runPromise(loadFixture("nodejs-compat"));
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

    it.effect("crypto.getRandomValues works", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/test-random");
        expect(res.status).toBe(200);
        const body = await res.text();
        const arr = JSON.parse(body);
        expect(arr).toHaveLength(4);
        for (const item of arr) {
          expect(typeof item).toBe("number");
        }
      }),
    );

    it.effect("Buffer.from works and encodes to base64", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/test-buffer");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("aGVsbG8=");
      }),
    );

    it.effect("process global is defined", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/test-process");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("OK");
      }),
    );

    it.effect("Buffer.isBuffer works", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/test-buffer-is-buffer");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("OK");
      }),
    );

    it.effect("responds to fetch /", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("ok");
      }),
    );
  });
});
