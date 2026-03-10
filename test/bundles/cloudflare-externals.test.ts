/**
 * Tests that `cloudflare:*` imports are correctly externalized.
 *
 * Workers that import from `cloudflare:workers` (DurableObject, etc.) or
 * `cloudflare:sockets` must have those imports preserved in the bundle output
 * as external imports — they're provided by the Workers runtime.
 */
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixture } from "../harness/fixture.js";
import { type RunningWorker, withRunner } from "../harness/miniflare-runner.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe("cloudflare-externals", () => {
  let config: BundleConfig;
  let wranglerBundle: BundleResult;

  beforeAll(async () => {
    config = await Effect.runPromise(loadFixture("cloudflare-externals"));
    wranglerBundle = await Effect.runPromise(bundleWithWrangler(config));
  });

  describe("wrangler baseline", () => {
    it("builds successfully", () => {
      expect(wranglerBundle.entryPoint).toBeTruthy();
      expect(wranglerBundle.bundleType).toBe("esm");
    });

    it("responds to fetch /", async () => {
      await Effect.runPromise(
        withRunner({ bundle: wranglerBundle, config }, async (runner) => {
          const res = await runner.fetch("http://localhost/");
          expect(res.status).toBe(200);
          expect(await res.text()).toBe("ok");
        }),
      );
    });

    it("responds to fetch /do (durable object)", async () => {
      await Effect.runPromise(
        withRunner({ bundle: wranglerBundle, config }, async (runner) => {
          const res = await runner.fetch("http://localhost/do");
          expect(res.status).toBe(200);
          expect(await res.text()).toBe("durable object ok");
        }),
      );
    });
  });

  // Uncomment when distilled-bundler implementation exists:
  // describe("distilled-bundler", () => {
  //   let distilledBundle: BundleResult;
  //
  //   beforeAll(async () => {
  //     distilledBundle = await Effect.runPromise(distilledBundler.bundle(config));
  //   });
  //
  //   it("entry point is ESM", () => {
  //     expect(distilledBundle.bundleType).toBe("esm");
  //   });
  //
  //   it("matches wrangler behavior for /", async () => {
  //     await Effect.runPromise(
  //       Effect.gen(function* () {
  //         const wranglerRes = yield* withRunner(
  //           { bundle: wranglerBundle, config },
  //           async (r) => ({ status: (await r.fetch("http://localhost/")).status, body: await (await r.fetch("http://localhost/")).text() })
  //         );
  //         const distilledRes = yield* withRunner(
  //           { bundle: distilledBundle, config },
  //           async (r) => ({ status: (await r.fetch("http://localhost/")).status, body: await (await r.fetch("http://localhost/")).text() })
  //         );
  //         expect(distilledRes.status).toBe(wranglerRes.status);
  //         expect(distilledRes.body).toBe(wranglerRes.body);
  //         expect(distilledRes.body).toBe("ok");
  //       }),
  //     );
  //   });
  // });
});
