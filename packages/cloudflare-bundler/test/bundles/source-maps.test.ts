/**
 * Tests that source maps are correctly generated alongside the bundle output.
 *
 * Both wrangler and distilled-bundler should emit .js.map files. The source
 * map should be valid JSON and reference the original source file(s).
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import { loadFixture } from "../harness/fixture.js";
import { outputPath } from "../harness/output.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";

describe("source-maps", () => {
  let config: BundleConfig;

  it.beforeAll(async () => {
    config = await loadFixture("node-env");
  });

  let bundle: BundleResult;

  it.beforeAll(async () => {
    bundle = await Effect.runPromise(bundleWithRolldown(config));
  });

  it("generates a .map file alongside the output", async () => {
    const mapPath = `${outputPath(bundle)}.map`;
    const exists = await fs.stat(mapPath).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(true);
  });

  it("source map is valid JSON with expected structure", async () => {
    const mapPath = `${outputPath(bundle)}.map`;
    const content = await fs.readFile(mapPath, "utf-8");
    const sourceMap = JSON.parse(content);
    expect(sourceMap).toHaveProperty("version", 3);
    expect(sourceMap).toHaveProperty("sources");
    expect(sourceMap).toHaveProperty("mappings");
    expect(Array.isArray(sourceMap.sources)).toBe(true);
  });

  it("source map references the original source file", async () => {
    const mapPath = `${outputPath(bundle)}.map`;
    const content = await fs.readFile(mapPath, "utf-8");
    const sourceMap = JSON.parse(content);
    const sources: Array<string> = sourceMap.sources;
    expect(sources.some((source: string) => source.includes("index.ts"))).toBe(true);
  });
});
