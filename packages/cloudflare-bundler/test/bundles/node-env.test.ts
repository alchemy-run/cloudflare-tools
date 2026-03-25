/**
 * Tests that `process.env.NODE_ENV` is correctly replaced via esbuild's `define`.
 *
 * Wrangler replaces `process.env.NODE_ENV` with "production" during deploy
 * (--dry-run counts as deploy context). This enables tree-shaking of
 * development-only code paths (e.g., React dev warnings).
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import { outputPath } from "../harness/output.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";

describe("node-env", () => {
  let config: BundleConfig;

  it.beforeAll(async () => {
    config = await Effect.runPromise(loadFixture("node-env"));
  });

  let bundle: BundleResult;

  it.beforeAll(async () => {
    bundle = await Effect.runPromise(bundleWithRolldown(config));
  });

  it("builds successfully", () => {
    expect(bundle.main).toBeTruthy();
  });

  it("inlines process.env.NODE_ENV as 'production' in output", async () => {
    const code = await fs.readFile(outputPath(bundle), "utf-8");
    expect(code).not.toContain("process.env.NODE_ENV");
    expect(code).toContain('"production"');
  });

  it.effect("responds to fetch /", () =>
    withRunner({ bundle, config }, async (runner) => {
      const res = await runner.fetch("http://localhost/");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    }),
  );

  it.effect("replaces process.env.NODE_ENV with 'production'", () =>
    withRunner({ bundle, config }, async (runner) => {
      const res = await runner.fetch("http://localhost/node-env");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("production");
    }),
  );

  it.effect("replaces global.process.env.NODE_ENV with 'production'", () =>
    withRunner({ bundle, config }, async (runner) => {
      const res = await runner.fetch("http://localhost/global-node-env");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("production");
    }),
  );

  it.effect("replaces globalThis.process.env.NODE_ENV with 'production'", () =>
    withRunner({ bundle, config }, async (runner) => {
      const res = await runner.fetch("http://localhost/globalthis-node-env");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("production");
    }),
  );
});
