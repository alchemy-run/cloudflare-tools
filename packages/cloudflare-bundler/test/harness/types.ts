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
  readonly rules?: ReadonlyArray<AdditionalModuleRule>;
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
