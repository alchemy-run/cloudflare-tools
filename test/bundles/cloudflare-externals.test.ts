/**
 * Tests that `cloudflare:*` imports are correctly externalized.
 *
 * Workers that import from `cloudflare:workers` (DurableObject, etc.) or
 * `cloudflare:sockets` must have those imports preserved in the bundle output
 * as external imports — they're provided by the Workers runtime.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import { outputPath } from "../harness/output.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";

describe("cloudflare-externals", () => {
  let config: BundleConfig;

  it.beforeAll(async () => {
    config = await Effect.runPromise(loadFixture("cloudflare-externals"));
  });

  let bundle: BundleResult;

  it.beforeAll(async () => {
    bundle = await Effect.runPromise(bundleWithRolldown(config));
  });

  it("builds successfully", async () => {
    expect(bundle.main).toBeTruthy();
    expect(bundle.format).toBe("esm");
    const exists = await fs.stat(outputPath(bundle)).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(true);
  });

  it("preserves cloudflare:* imports as external", async () => {
    const code = await fs.readFile(outputPath(bundle), "utf-8");
    expect(code).toContain("cloudflare:workers");
  });

  it.effect("responds to fetch /", () =>
    withRunner({ bundle, config }, async (runner) => {
      const res = await runner.fetch("http://localhost/");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    }),
  );

  it.effect("responds to fetch /do (durable object)", () =>
    withRunner({ bundle, config }, async (runner) => {
      const res = await runner.fetch("http://localhost/do");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("durable object ok");
    }),
  );
});
