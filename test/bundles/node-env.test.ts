/**
 * Tests that `process.env.NODE_ENV` is correctly replaced via esbuild's `define`.
 *
 * Wrangler replaces `process.env.NODE_ENV` with "production" during deploy
 * (--dry-run counts as deploy context). This enables tree-shaking of
 * development-only code paths (e.g., React dev warnings).
 */
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe("node-env", () => {
  let config: BundleConfig;
  let wranglerBundle: BundleResult;

  beforeAll(async () => {
    config = await Effect.runPromise(loadFixture("node-env"));
    wranglerBundle = await Effect.runPromise(bundleWithWrangler(config));
  });

  describe("wrangler baseline", () => {
    it("builds successfully", () => {
      expect(wranglerBundle.entryPoint).toBeTruthy();
      expect(wranglerBundle.bundleType).toBe("esm");
    });

    it("replaces process.env.NODE_ENV with 'production'", async () => {
      await Effect.runPromise(
        withRunner({ bundle: wranglerBundle, config }, async (runner) => {
          const res = await runner.fetch("http://localhost/node-env");
          expect(res.status).toBe(200);
          expect(await res.text()).toBe("production");
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
