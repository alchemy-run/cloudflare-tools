/**
 * Tests that `navigator.userAgent` is correctly defined as `"Cloudflare-Workers"`.
 *
 * When the compatibility date is >= 2022-03-21, wrangler defines
 * `navigator.userAgent` as `"Cloudflare-Workers"`. This enables tree-shaking
 * of browser-detection branches (e.g., choosing between node:crypto and
 * the Web Crypto API).
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import { outputPath } from "../harness/output.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";

describe("navigator-user-agent", () => {
  let config: BundleConfig;

  it.beforeAll(async () => {
    config = await Effect.runPromise(loadFixture("navigator-user-agent"));
  });

  let bundle: BundleResult;

  it.beforeAll(async () => {
    bundle = await Effect.runPromise(bundleWithRolldown(config));
  });

  it("builds successfully", () => {
    expect(bundle.main).toBeTruthy();
  });

  it("inlines navigator.userAgent as 'Cloudflare-Workers' in output", async () => {
    const code = await fs.readFile(outputPath(bundle), "utf-8");
    expect(code).toContain("Cloudflare-Workers");
    expect(code).not.toContain("navigator.userAgent");
  });

  it("replaces navigator.userAgent comparison with constant true", async () => {
    const code = await fs.readFile(outputPath(bundle), "utf-8");
    expect(code).not.toContain('navigator.userAgent === "Cloudflare-Workers"');
  });

  it.effect("returns Cloudflare-Workers for /user-agent", () =>
    withRunner({ bundle, config }, async (runner) => {
      const res = await runner.fetch("http://localhost/user-agent");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("Cloudflare-Workers");
    }),
  );
});
