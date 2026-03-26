/**
 * Tests that JSX syntax is supported in .js files.
 *
 * Wrangler configures esbuild with `loader: { ".js": "jsx" }` so that
 * plain .js files can contain JSX syntax without requiring a .jsx or .tsx
 * extension.
 */
import { beforeAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe.concurrent("jsx-in-js", () => {
  let config: BundleConfig;

  beforeAll(async () => {
    config = await loadFixture("jsx-in-js");
  });

  describe.each([
    { name: "wrangler", fn: bundleWithWrangler },
    { name: "rolldown", fn: bundleWithRolldown },
  ])("$name", ({ fn }) => {
    let bundle: BundleResult;

    it.beforeAll(async () => {
      bundle = await Effect.runPromise(fn(config));
    });

    it("builds successfully with JSX in .js file", () => {
      expect(bundle.main).toBeTruthy();
    });

    it.effect("responds to fetch /", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("ok");
      }),
    );

    it.effect("jsx is transformed and works at runtime", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/jsx");
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toHaveProperty("tag", "div");
      }),
    );
  });
});
