import { beforeAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe.concurrent("nodejs-compat-v2", () => {
  let config: BundleConfig;

  beforeAll(async () => {
    config = await loadFixture("nodejs-compat-v2");
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

    it.effect("Buffer.from works and encodes to base64", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/test-buffer");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("aGVsbG8=");
      }),
    );

    it.effect("crypto.getRandomValues works", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/test-random");
        expect(res.status).toBe(200);
        const body = await res.text();
        const arr = JSON.parse(body);
        expect(arr).toHaveLength(4);
      }),
    );

    it.effect("process global is defined", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/test-process");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("OK");
      }),
    );

    it.effect("Buffer.isBuffer works", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/test-buffer-is-buffer");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("OK");
      }),
    );
  });
});
