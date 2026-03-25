/**
 * Tests that various `cloudflare:*` submodules are correctly externalized.
 *
 * Workers can import from multiple cloudflare:* namespaces (workers, sockets,
 * email, etc.). All must be preserved as external imports in the bundle output.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import { loadFixture } from "../harness/fixture.js";
import { outputPath } from "../harness/output.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";

describe("cloudflare-submodules", () => {
  let config: BundleConfig;

  it.beforeAll(async () => {
    config = await loadFixture("cloudflare-submodules");
  });

  let bundle: BundleResult;

  it.beforeAll(async () => {
    bundle = await Effect.runPromise(bundleWithRolldown(config));
  });

  it("builds successfully", () => {
    expect(bundle.main).toBeTruthy();
  });

  it("preserves cloudflare:workers as external import", async () => {
    const code = await fs.readFile(outputPath(bundle), "utf-8");
    expect(code).toContain("cloudflare:workers");
  });

  it("preserves cloudflare:sockets as external import", async () => {
    const code = await fs.readFile(outputPath(bundle), "utf-8");
    expect(code).toContain("cloudflare:sockets");
  });
});
