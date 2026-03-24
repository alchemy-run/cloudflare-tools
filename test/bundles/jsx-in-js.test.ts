/**
 * Tests that JSX syntax is supported in .js files.
 *
 * Wrangler configures esbuild with `loader: { ".js": "jsx" }` so that
 * plain .js files can contain JSX syntax without requiring a .jsx or .tsx
 * extension.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";

describe("jsx-in-js", () => {
  let config: BundleConfig;

  it.beforeAll(async () => {
    config = await Effect.runPromise(loadFixture("jsx-in-js"));
  });

  let bundle: BundleResult;

  it.beforeAll(async () => {
    bundle = await Effect.runPromise(bundleWithRolldown(config));
  });

  it("builds successfully with JSX in .js file", () => {
    expect(bundle.main).toBeTruthy();
    expect(bundle.format).toBe("esm");
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
