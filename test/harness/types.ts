/**
 * Core types for the distilled-bundler test harness.
 *
 * These types are bundler-agnostic — they define the interface between
 * fixture configs, bundler adapters, and the Miniflare runner.
 */

import type { Module } from "../../src/module.js";
import type { Rule } from "../../src/module-rules.js";

/**
 * Configuration for bundling a fixture. Parsed from wrangler.jsonc.
 */
export interface BundleConfig {
  /** Absolute path to the entry point (resolved from wrangler.jsonc "main") */
  readonly entryPoint: string;
  /** Absolute path to the fixture directory */
  readonly projectRoot: string;
  /** Cloudflare compatibility date */
  readonly compatibilityDate: string;
  /** Cloudflare compatibility flags (e.g., ["nodejs_compat"]) */
  readonly compatibilityFlags: ReadonlyArray<string>;
  /** esbuild define replacements */
  readonly define?: Record<string, string>;
  /** Module rules for non-JS imports */
  readonly rules?: ReadonlyArray<Rule>;
  /** Whether to scan the filesystem for additional modules (dynamic imports) */
  readonly findAdditionalModules?: boolean;
  /** Preserve original file names instead of hashing */
  readonly preserveFileNames?: boolean;
  /** Additional modules to mark as external */
  readonly external?: ReadonlyArray<string>;
  /** Durable Object bindings */
  readonly durableObjects?: ReadonlyArray<DurableObjectBinding>;
  /** Whether to minify the output */
  readonly minify?: boolean;
  /** Whether to preserve function/class names (default: true) */
  readonly keepNames?: boolean;
  /** Path to tsconfig.json (relative to projectRoot) */
  readonly tsconfig?: string;
  /** Module format override */
  readonly format?: "modules" | "service-worker";
}

/**
 * A Durable Object binding declaration.
 */
export interface DurableObjectBinding {
  readonly name: string;
  readonly class_name: string;
  readonly script_name?: string;
}

/**
 * The output of a bundling operation.
 */
export interface BundleResult {
  /** Absolute path to the main output file */
  readonly main: string;
  /** Additional modules collected during bundling (WASM, text, data, etc.) */
  readonly modules: ReadonlyArray<Module>;
  /** The module format of the entry point */
  readonly type: "esm" | "commonjs";
  /** Absolute path to the output directory */
  readonly outputDir: string;
}

/**
 * Maps file extensions to Module.Type for parsing wrangler output.
 */
export function moduleTypeFromExtension(ext: string): Module.Type | null {
  switch (ext) {
    case ".wasm":
      return "CompiledWasm";
    case ".txt":
    case ".html":
    case ".sql":
      return "Text";
    case ".bin":
      return "Data";
    case ".mjs":
    case ".js":
      return "ESModule";
    case ".cjs":
      return "CommonJS";
    default:
      return null;
  }
}
