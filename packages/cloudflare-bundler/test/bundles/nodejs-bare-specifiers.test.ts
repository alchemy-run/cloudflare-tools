import { beforeAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe.concurrent("nodejs-bare-specifiers", () => {
  let config: BundleConfig;

  beforeAll(async () => {
    config = await loadFixture("nodejs-bare-specifiers");
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

    it.effect("resolves bare builtin specifiers", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/join");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("a/b");
      }),
    );
  });
});
