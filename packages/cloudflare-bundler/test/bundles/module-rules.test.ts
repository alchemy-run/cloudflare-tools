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
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";

describe("module-rules", () => {
  let config: BundleConfig;

  it.beforeAll(async () => {
    config = await loadFixture("module-rules");
  });

  let bundle: BundleResult;

  it.beforeAll(async () => {
    bundle = await Effect.runPromise(bundleWithRolldown(config));
  });

  it("builds successfully", () => {
    expect(bundle.main).toBeTruthy();
  });

  it("collects WASM module", () => {
    const wasmModule = bundle.modules.find((m) => m.type === "CompiledWasm");
    expect(wasmModule).toBeDefined();
    expect(wasmModule!.name).toMatch(/add\.wasm$/);
  });

  it("collects text module", () => {
    const textModule = bundle.modules.find((m) => m.type === "Text");
    expect(textModule).toBeDefined();
    expect(textModule!.name).toMatch(/test\.txt$/);
  });

  it("collects binary module", () => {
    const binModule = bundle.modules.find((m) => m.type === "Data");
    expect(binModule).toBeDefined();
    expect(binModule!.name).toMatch(/test\.bin$/);
  });

  it.effect("WASM add(1, 2) returns 3", () =>
    withRunner({ bundle, config }, async (runner) => {
      const res = await runner.fetch("http://localhost/wasm");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("3");
    }),
  );

  it.effect("text module returns content", () =>
    withRunner({ bundle, config }, async (runner) => {
      const res = await runner.fetch("http://localhost/text");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello world");
    }),
  );

  it.effect("binary module returns bytes", () =>
    withRunner({ bundle, config }, async (runner) => {
      const res = await runner.fetch("http://localhost/bin");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("[0,1,2,3]");
    }),
  );

  it.effect("responds to fetch /", () =>
    withRunner({ bundle, config }, async (runner) => {
      const res = await runner.fetch("http://localhost/");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    }),
  );
});
