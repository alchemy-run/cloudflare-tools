/**
 * Tests that various `cloudflare:*` submodules are correctly externalized.
 *
 * Workers can import from multiple cloudflare:* namespaces (workers, sockets,
 * email, etc.). All must be preserved as external imports in the bundle output.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import { bundleWithEsbuild } from "../harness/esbuild-bundler.js";
import { loadFixture } from "../harness/fixture.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe("cloudflare-submodules", () => {
  let config: BundleConfig;

  it.beforeAll(async () => {
    config = await Effect.runPromise(loadFixture("cloudflare-submodules"));
  });

  describe.each([
    {
      name: "wrangler",
      bundler: bundleWithWrangler,
    },
    {
      name: "esbuild",
      bundler: bundleWithEsbuild,
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

    it("preserves cloudflare:workers as external import", async () => {
      const code = await fs.readFile(bundle.main, "utf-8");
      expect(code).toContain("cloudflare:workers");
    });

    it("preserves cloudflare:sockets as external import", async () => {
      const code = await fs.readFile(bundle.main, "utf-8");
      expect(code).toContain("cloudflare:sockets");
    });
  });
});
