/**
 * Tests that `__STATIC_CONTENT_MANIFEST` is correctly externalized.
 *
 * Workers using Cloudflare Pages or Workers Sites import from
 * `__STATIC_CONTENT_MANIFEST` to access the asset manifest. This import
 * must be preserved as external — the runtime provides it.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import { bundleWithEsbuild } from "../harness/esbuild-bundler.js";
import { loadFixture } from "../harness/fixture.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe("static-content-manifest", () => {
  let config: BundleConfig;

  it.beforeAll(async () => {
    config = await Effect.runPromise(loadFixture("static-content-manifest"));
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

    it("preserves __STATIC_CONTENT_MANIFEST as external import", async () => {
      const code = await fs.readFile(bundle.main, "utf-8");
      expect(code).toContain("__STATIC_CONTENT_MANIFEST");
    });
  });
});
