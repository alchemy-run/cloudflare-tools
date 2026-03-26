/**
 * Tests that user-supplied `define` config correctly replaces identifiers.
 *
 * Workers can specify custom `define` entries in wrangler config to replace
 * top-level identifiers with constant values at build time. The bundler must
 * apply these alongside the default `process.env.NODE_ENV` replacement.
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

describe.concurrent("custom-define", () => {
  let config: BundleConfig;

  beforeAll(async () => {
    config = await loadFixture("custom-define");
  });

  describe.each([
    { name: "wrangler", fn: bundleWithWrangler },
    { name: "rolldown", fn: bundleWithRolldown },
  ])("$name", ({ fn }) => {
    let bundle: BundleResult;

    it.beforeAll(async () => {
      bundle = await Effect.runPromise(fn(config));
    });

    it("builds successfully", () => {
      expect(bundle.main).toBeTruthy();
    });

    it("inlines MY_CONSTANT in output", async () => {
      const code = await fs.readFile(outputPath(bundle), "utf-8");
      expect(code).toContain("hello-world");
    });

    it.effect("returns defined constant for /constant", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/constant");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("hello-world");
      }),
    );

    it.effect("returns defined version for /version", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/version");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("42");
      }),
    );

    it.effect("still replaces process.env.NODE_ENV alongside custom defines", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/node-env");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("production");
      }),
    );
  });
});
