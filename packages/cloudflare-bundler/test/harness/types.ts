/**
 * Core types for the distilled-bundler test harness.
 *
 * These types are bundler-agnostic — they define the interface between
 * fixture configs, bundler adapters, and the Miniflare runner.
 */

import type { AdditionalModuleRule } from "../../src/Input.js";
import type { Output } from "../../src/Output.js";

/**
 * Configuration for bundling a fixture. Parsed from wrangler.jsonc.
 */
export interface BundleConfig {
  /** Absolute path to the entry point (resolved from wrangler.jsonc "main") */
  entryPoint: string;
  /** Absolute path to the fixture directory */
  projectRoot: string;
  /** Cloudflare compatibility date */
  compatibilityDate: string;
  /** Cloudflare compatibility flags (e.g., ["nodejs_compat"]) */
  compatibilityFlags: Array<string>;
  /** esbuild define replacements */
  define?: Record<string, string>;
  /** Module rules for non-JS imports */
  rules?: Array<AdditionalModuleRule>;
  /** Preserve original file names instead of hashing */
  preserveFileNames?: boolean;
  /** Additional modules to mark as external */
  external?: Array<string>;
  /** Durable Object bindings */
  durableObjects?: Array<DurableObjectBinding>;
  /** Whether to minify the output */
  minify?: boolean;
  /** Whether to preserve function/class names (default: true) */
  keepNames?: boolean;
  /** Path to tsconfig.json (relative to projectRoot) */
  tsconfig?: string;
}

/**
 * A Durable Object binding declaration.
 */
export interface DurableObjectBinding {
  readonly name: string;
  readonly class_name: string;
  readonly script_name?: string;
}

export type BundleResult = Output;
