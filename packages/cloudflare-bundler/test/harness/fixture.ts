/**
 * Fixture loading utilities.
 *
 * Parses wrangler.jsonc files from test fixtures and produces BundleConfig
 * objects that can be passed to any BundlerAdapter.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Unstable_Config } from "wrangler";
import type { BundleConfig } from "./types.js";

/**
 * Returns the absolute path to a fixture directory.
 */
export function fixtureDir(fixtureName: string): string {
  return path.resolve(import.meta.dirname, "..", "fixtures", fixtureName);
}

/**
 * Loads a fixture's wrangler.jsonc and produces a BundleConfig.
 *
 * Searches for wrangler.jsonc, wrangler.json, or wrangler.toml (jsonc/json only
 * for now — toml parsing is not implemented).
 */
export async function loadFixture(fixtureName: string): Promise<BundleConfig> {
  const root = fixtureDir(fixtureName);

  // Find the config file
  const configPath = path.join(root, "wrangler.json");
  const raw = await fs.readFile(configPath, "utf-8");
  const config = JSON.parse(raw) as Unstable_Config;

  return {
    entryPoint: config.main!,
    projectRoot: root,
    compatibilityDate: config.compatibility_date ?? "2025-01-01",
    compatibilityFlags: config.compatibility_flags ?? [],
    define: config.define,
    rules: config.rules,
    preserveFileNames: config.preserve_file_names,
    durableObjects: config.durable_objects?.bindings,
    minify: config.minify,
    keepNames: config.keep_names,
    tsconfig: config.tsconfig,
  };
}
