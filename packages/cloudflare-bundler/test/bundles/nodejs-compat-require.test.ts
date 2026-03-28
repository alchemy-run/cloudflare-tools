import { beforeAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import { outputPath } from "../harness/output.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";

describe.concurrent("nodejs-compat-require", () => {
  let config: BundleConfig;
  let bundle: BundleResult;

  beforeAll(async () => {
    config = await loadFixture("nodejs-compat-require");
    bundle = await Effect.runPromise(bundleWithRolldown(config));
  });

  it("builds successfully", () => {
    expect(bundle.main).toBeTruthy();
  });

  it("does not inject a global require shim", async () => {
    const code = await fs.readFile(outputPath(bundle), "utf-8");
    expect(code).not.toContain("globalThis.require");
  });

  it.effect("supports external builtin require() calls in ESM output", () =>
    withRunner({ bundle, config }, async (runner) => {
      const res = await runner.fetch("http://localhost/join");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("a/b");
    }),
  );
});
