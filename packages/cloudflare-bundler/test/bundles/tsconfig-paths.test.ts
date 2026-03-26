/**
 * Tests that tsconfig `compilerOptions.paths` are respected during bundling.
 *
 * Workers using path aliases (e.g., `~lib/*` -> `src/lib/*`) should have
 * those paths resolved correctly by esbuild when a tsconfig is provided.
 */
import { beforeAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe.concurrent("tsconfig-paths", () => {
  let config: BundleConfig;

  beforeAll(async () => {
    config = await loadFixture("tsconfig-paths");
  });

  describe.each([
    { name: "wrangler", fn: bundleWithWrangler },
    { name: "rolldown", fn: bundleWithRolldown },
  ])("$name", ({ fn }) => {
    let bundle: BundleResult;

    it.beforeAll(async () => {
      bundle = await Effect.runPromise(fn(config));
    });

    it("builds successfully with tsconfig path aliases", () => {
      expect(bundle.main).toBeTruthy();
    });

    it.effect("resolves path alias and responds correctly", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/greet");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("Hello, world!");
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
