/**
 * Tests that esbuild resolve conditions are correctly configured.
 *
 * Workers should resolve package.json `exports` using the conditions
 * `["workerd", "worker", "browser"]` in that order. This ensures
 * packages with Workers-specific entry points are resolved correctly.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { bundleWithDistilled } from "../harness/distilled-bundler.js";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe("build-conditions", () => {
  let config: BundleConfig;

  it.beforeAll(async () => {
    config = await Effect.runPromise(loadFixture("build-conditions"));
  });

  describe.each([
    {
      name: "wrangler",
      bundler: bundleWithWrangler,
    },
    {
      name: "distilled-bundler",
      bundler: bundleWithDistilled,
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

    it.effect("resolves 'workerd' condition first", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/platform");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("workerd");
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
