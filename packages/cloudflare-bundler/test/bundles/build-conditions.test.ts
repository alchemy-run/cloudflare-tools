/**
 * Tests that esbuild resolve conditions are correctly configured.
 *
 * Workers should resolve package.json `exports` using the conditions
 * `["workerd", "worker", "browser"]` in that order. This ensures
 * packages with Workers-specific entry points are resolved correctly.
 */
import { beforeAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe.concurrent("build-conditions", () => {
  let config: BundleConfig;

  beforeAll(async () => {
    config = await loadFixture("build-conditions");
  });

  describe.each([
    { name: "wrangler", fn: bundleWithWrangler },
    { name: "rolldown", fn: bundleWithRolldown },
  ])("$name", ({ fn }) => {
    let bundle: BundleResult;

    it.beforeAll(async () => {
      bundle = await Effect.runPromise(fn(config));
    });

    it("builds successfully", () => {
      expect(bundle.main).toBeTruthy();
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
