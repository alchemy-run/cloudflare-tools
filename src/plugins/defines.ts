/**
 * Defines computation.
 *
 * Not a plugin — this computes the `define` map that gets passed to the
 * bundler's own define mechanism. Handles `process.env.NODE_ENV`,
 * `navigator.userAgent`, and user-provided defines.
 *
 * @module
 */

export interface DefinesOptions {
  /** Build mode — determines process.env.NODE_ENV value */
  readonly mode?: "production" | "development";

  /**
   * Whether to define `navigator.userAgent` as `"Cloudflare-Workers"`.
   * When true, references to navigator.userAgent are replaced at build time,
   * enabling tree-shaking of browser-only code paths.
   */
  readonly defineNavigatorUserAgent?: boolean;

  /**
   * Whether nodejs_compat_v2 is enabled. When false, `process.env` itself
   * is replaced with `{}` (not just `process.env.NODE_ENV`), since there's
   * no runtime `process` object.
   */
  readonly hasNodejsCompat?: boolean;

  /** User-provided define replacements */
  readonly userDefines?: Readonly<Record<string, string>>;
}

/**
 * Compute the full set of define replacements for a Workers bundle.
 */
export function computeDefines(options?: DefinesOptions): Record<string, string> {
  const mode = options?.mode ?? "production";
  const nodeEnv = JSON.stringify(mode);
  const hasNodejsCompat = options?.hasNodejsCompat ?? false;

  const defines: Record<string, string> = {
    "process.env.NODE_ENV": nodeEnv,
    "global.process.env.NODE_ENV": nodeEnv,
    "globalThis.process.env.NODE_ENV": nodeEnv,
  };

  // Without nodejs_compat, there's no runtime `process` object, so
  // replace the entire `process.env` with an empty object.
  // This must come AFTER the NODE_ENV-specific defines so that
  // bundlers match the more specific pattern first.
  if (!hasNodejsCompat) {
    defines["process.env"] = "{}";
    defines["global.process.env"] = "{}";
    defines["globalThis.process.env"] = "{}";
  }

  if (options?.defineNavigatorUserAgent) {
    defines["navigator.userAgent"] = JSON.stringify("Cloudflare-Workers");
  }

  // User defines take precedence
  if (options?.userDefines) {
    Object.assign(defines, options.userDefines);
  }

  return defines;
}

/**
 * Determine whether `navigator.userAgent` should be defined based on
 * compatibility date and flags (mirrors Wrangler's logic).
 *
 * The `global_navigator` flag was introduced on 2022-03-21.
 */
export function shouldDefineNavigatorUserAgent(
  compatibilityDate?: string,
  compatibilityFlags?: ReadonlyArray<string>,
): boolean {
  const flags = compatibilityFlags ?? [];

  if (flags.includes("global_navigator") && flags.includes("no_global_navigator")) {
    throw new Error(
      "Cannot set both global_navigator and no_global_navigator compatibility flags.",
    );
  }

  if (flags.includes("global_navigator")) {
    return true;
  }
  if (flags.includes("no_global_navigator")) {
    return false;
  }

  // Default: enabled for dates >= 2022-03-21
  if (compatibilityDate && compatibilityDate >= "2022-03-21") {
    return true;
  }

  return false;
}
