/**
 * Tests that module rules correctly handle WASM, text, and binary imports.
 *
 * Workers can import non-JS files which are collected as separate modules
 * in the upload. The bundler must:
 * - Detect .wasm files and collect them as CompiledWasm modules
 * - Detect .txt files and collect them as Text modules
 * - Detect .bin files and collect them as Data (buffer) modules
 * - Mark these imports as external so they remain as separate modules
 */
import * as Effect from "effect/Effect";
import { beforeAll, describe, expect, it } from "vitest";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";
import { bundleWithWrangler } from "../harness/wrangler-bundler.js";

describe("module-rules", () => {
  let config: BundleConfig;
  let wranglerBundle: BundleResult;

  beforeAll(async () => {
    config = await Effect.runPromise(loadFixture("module-rules"));
    wranglerBundle = await Effect.runPromise(bundleWithWrangler(config));
  });

  describe("wrangler baseline", () => {
    it("builds successfully", () => {
      expect(wranglerBundle.entryPoint).toBeTruthy();
      expect(wranglerBundle.bundleType).toBe("esm");
    });

    it("collects WASM module", () => {
      const wasmModule = wranglerBundle.modules.find((m) => m.type === "compiled-wasm");
      expect(wasmModule).toBeDefined();
      expect(wasmModule!.name).toMatch(/add\.wasm$/);
    });

    it("collects text module", () => {
      const textModule = wranglerBundle.modules.find((m) => m.type === "text");
      expect(textModule).toBeDefined();
      expect(textModule!.name).toMatch(/test\.txt$/);
    });

    it("collects binary module", () => {
      const binModule = wranglerBundle.modules.find((m) => m.type === "buffer");
      expect(binModule).toBeDefined();
      expect(binModule!.name).toMatch(/test\.bin$/);
    });

    it("WASM add(1, 2) returns 3", async () => {
      await Effect.runPromise(
        withRunner({ bundle: wranglerBundle, config }, async (runner) => {
          const res = await runner.fetch("http://localhost/wasm");
          expect(res.status).toBe(200);
          expect(await res.text()).toBe("3");
        }),
      );
    });

    it("text module returns content", async () => {
      await Effect.runPromise(
        withRunner({ bundle: wranglerBundle, config }, async (runner) => {
          const res = await runner.fetch("http://localhost/text");
          expect(res.status).toBe(200);
          expect(await res.text()).toBe("hello world");
        }),
      );
    });

    it("binary module returns bytes", async () => {
      await Effect.runPromise(
        withRunner({ bundle: wranglerBundle, config }, async (runner) => {
          const res = await runner.fetch("http://localhost/bin");
          expect(res.status).toBe(200);
          expect(await res.text()).toBe("[0,1,2,3]");
        }),
      );
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
  });

  // Uncomment when distilled-bundler implementation exists:
  // describe("distilled-bundler", () => { ... });
});
