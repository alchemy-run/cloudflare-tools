/**
 * Tests that named exports are preserved in ESM output.
 *
 * Workers can export named values (classes, constants) alongside the default
 * export. These must be preserved in the bundled output — Durable Object
 * classes, for example, are discovered by name.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import { outputPath } from "../harness/output.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";

describe("named-exports", () => {
  let config: BundleConfig;

  it.beforeAll(async () => {
    config = await Effect.runPromise(loadFixture("named-exports"));
  });

  let bundle: BundleResult;

  it.beforeAll(async () => {
    bundle = await Effect.runPromise(bundleWithRolldown(config));
  });

  it("builds successfully with ESM output", () => {
    expect(bundle.main).toBeTruthy();
  });

  it("preserves MyDO class export", async () => {
    const code = await fs.readFile(outputPath(bundle), "utf-8");
    expect(code).toMatch(/export\s*\{[^}]*MyDO/);
  });

  it("preserves WorkerMetadata named export", async () => {
    const code = await fs.readFile(outputPath(bundle), "utf-8");
    expect(code).toMatch(/export\s*\{[^}]*WorkerMetadata/);
  });

  it.effect("responds to fetch /", () =>
    withRunner({ bundle, config }, async (runner) => {
      const res = await runner.fetch("http://localhost/");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    }),
  );

  it.effect("named export class is accessible at runtime", () =>
    withRunner({ bundle, config }, async (runner) => {
      const res = await runner.fetch("http://localhost/version");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("1.0.0");
    }),
  );
});
