/**
 * Configuration types for the Cloudflare Workers bundler.
 *
 * These types mirror the relevant subset of wrangler.json configuration
 * needed for bundling. The bundler reads a wrangler.json(c) and converts
 * it to a `BundleConfig`.
 *
 * @module
 */

/**
 * A module rule mapping file globs to Workers module types.
 */
export interface ModuleRule {
  readonly type: "CompiledWasm" | "Data" | "Text";
  readonly globs: ReadonlyArray<string>;
  readonly fallthrough?: boolean;
}

/**
 * Default module rules matching Wrangler's defaults.
 */
export const DEFAULT_MODULE_RULES: ReadonlyArray<ModuleRule> = [
  { type: "CompiledWasm", globs: ["**/*.wasm", "**/*.wasm?module"] },
  { type: "Data", globs: ["**/*.bin"] },
  { type: "Text", globs: ["**/*.txt", "**/*.html", "**/*.sql"] },
];

/**
 * Configuration for a single bundle operation.
 *
 * This is the bundler-agnostic configuration — it contains everything
 * needed to produce a bundle, regardless of which bundler is used.
 */
export interface BundleConfig {
  /** Path to the worker entry point */
  readonly entry: string;

  /** Output directory for the bundle */
  readonly outDir: string;

  /** Worker name (informational) */
  readonly name?: string;

  /** Compatibility date for the Workers runtime */
  readonly compatibilityDate?: string;

  /** Compatibility flags (e.g. ["nodejs_compat_v2"]) */
  readonly compatibilityFlags?: ReadonlyArray<string>;

  /** Additional module rules beyond defaults */
  readonly rules?: ReadonlyArray<ModuleRule>;

  /** Whether to minify the output */
  readonly minify?: boolean;

  /** Whether to generate source maps */
  readonly sourcemap?: boolean;

  /** Custom define replacements (e.g. { "MY_VAR": '"value"' }) */
  readonly define?: Readonly<Record<string, string>>;

  /** Custom alias mappings */
  readonly alias?: Readonly<Record<string, string>>;

  /** Additional external modules (beyond cloudflare:* builtins) */
  readonly external?: ReadonlyArray<string>;

  /**
   * Build mode.
   * - "production" (default): process.env.NODE_ENV = "production"
   * - "development": process.env.NODE_ENV = "development"
   */
  readonly mode?: "production" | "development";

  /**
   * Whether to define navigator.userAgent as "Cloudflare-Workers".
   * Automatically determined from compatibility date/flags if not set.
   */
  readonly defineNavigatorUserAgent?: boolean;
}
