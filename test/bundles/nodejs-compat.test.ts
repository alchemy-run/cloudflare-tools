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
import * as Effect from "effect/Effect";
import { beforeAll, describe, expect, it } from "vitest";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe("nodejs-compat", () => {
  let config: BundleConfig;
  let wranglerBundle: BundleResult;

  beforeAll(async () => {
    config = await Effect.runPromise(loadFixture("nodejs-compat"));
    wranglerBundle = await Effect.runPromise(bundleWithWrangler(config));
  });

  describe("wrangler baseline", () => {
    it("builds successfully", () => {
      expect(wranglerBundle.entryPoint).toBeTruthy();
      expect(wranglerBundle.bundleType).toBe("esm");
    });

    it("crypto.getRandomValues works", async () => {
      await Effect.runPromise(
        withRunner({ bundle: wranglerBundle, config }, async (runner) => {
          const res = await runner.fetch("http://localhost/test-random");
          expect(res.status).toBe(200);
          const body = await res.text();
          const arr = JSON.parse(body);
          expect(arr).toHaveLength(4);
          // Each element should be a number
          for (const item of arr) {
            expect(typeof item).toBe("number");
          }
        }),
      );
    });

    it("Buffer.from works and encodes to base64", async () => {
      await Effect.runPromise(
        withRunner({ bundle: wranglerBundle, config }, async (runner) => {
          const res = await runner.fetch("http://localhost/test-buffer");
          expect(res.status).toBe(200);
          // "hello" in base64 = "aGVsbG8="
          expect(await res.text()).toBe("aGVsbG8=");
        }),
      );
    });

    it("process global is defined", async () => {
      await Effect.runPromise(
        withRunner({ bundle: wranglerBundle, config }, async (runner) => {
          const res = await runner.fetch("http://localhost/test-process");
          expect(res.status).toBe(200);
          expect(await res.text()).toBe("OK");
        }),
      );
    });

    it("Buffer.isBuffer works", async () => {
      await Effect.runPromise(
        withRunner({ bundle: wranglerBundle, config }, async (runner) => {
          const res = await runner.fetch("http://localhost/test-buffer-is-buffer");
          expect(res.status).toBe(200);
          expect(await res.text()).toBe("OK");
        }),
      );
    });

    it("responds to fetch /", async () => {
      await Effect.runPromise(
        withRunner({ bundle: wranglerBundle, config }, async (runner) => {
          const res = await runner.fetch("http://localhost/");
          expect(res.status).toBe(200);
          expect(await res.text()).toBe("ok");
        }),
      );
    });
  });

  // Uncomment when distilled-bundler implementation exists:
  // describe("distilled-bundler", () => { ... });
});
