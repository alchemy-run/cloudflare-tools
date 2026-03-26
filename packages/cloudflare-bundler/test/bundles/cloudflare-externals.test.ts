/**
 * Tests that `cloudflare:*` imports are correctly externalized.
 *
 * Workers that import from `cloudflare:workers` (DurableObject, etc.) or
 * `cloudflare:sockets` must have those imports preserved in the bundle output
 * as external imports — they're provided by the Workers runtime.
 */
import { beforeAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import { outputPath } from "../harness/output.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe.concurrent("cloudflare-externals", () => {
  let config: BundleConfig;

  beforeAll(async () => {
    config = await loadFixture("cloudflare-externals");
  });

  describe.each([
    { name: "wrangler", fn: bundleWithWrangler },
    { name: "rolldown", fn: bundleWithRolldown },
  ])("$name", ({ fn }) => {
    let bundle: BundleResult;

    it.beforeAll(async () => {
      bundle = await Effect.runPromise(fn(config));
    });

    it("builds successfully", async () => {
      expect(bundle.main).toBeTruthy();
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
});
