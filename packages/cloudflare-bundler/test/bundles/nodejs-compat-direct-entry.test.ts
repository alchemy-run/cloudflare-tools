import { beforeAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";

describe.concurrent("nodejs-compat-direct-entry", () => {
  let config: BundleConfig;
  let bundle: BundleResult;

  beforeAll(async () => {
    config = await loadFixture("nodejs-compat-direct-entry");
    bundle = await Effect.runPromise(bundleWithRolldown(config));
  });

  it("builds successfully", () => {
    expect(bundle.main).toBeTruthy();
  });

  it.effect("resolves compat entries from the bundler context", () =>
    withRunner({ bundle, config }, async (runner) => {
      const res = await runner.fetch("http://localhost/process");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("OK");
    }),
  );
});
