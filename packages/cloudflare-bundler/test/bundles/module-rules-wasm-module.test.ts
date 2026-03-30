import { beforeAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe.concurrent("module-rules-wasm-module", () => {
  let config: BundleConfig;

  beforeAll(async () => {
    config = await loadFixture("module-rules-wasm-module");
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

    it("collects the wasm module imported with ?module", () => {
      const wasmModule = bundle.modules.find((m) => m.type === "CompiledWasm");
      expect(wasmModule).toBeDefined();
      expect(wasmModule!.name).toMatch(/add\.wasm$/);
    });

    it.effect("WASM add(3, 4) returns 7", () =>
      withRunner({ bundle, config }, async (runner) => {
        const res = await runner.fetch("http://localhost/");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("7");
      }),
    );
  });
});
