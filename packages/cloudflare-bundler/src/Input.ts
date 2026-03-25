import type { ModuleType } from "./Module.js";

export interface Input {
  /** The absolute or relative path to the Worker entry module. */
  readonly main: string;
  /** The project root. Defaults to the current working directory. */
  readonly rootDir?: string;
  /** The output directory. Defaults to `dist`. */
  readonly outDir?: string;
  /** Whether to minify the output. */
  readonly minify?: boolean;
  /** Whether to preserve function and class names. Defaults to `true`. */
  readonly keepNames?: boolean;
  /** Additional modules to mark as external. */
  readonly external?: ReadonlyArray<string>;
  /** Bundler define replacements. */
  readonly define?: Record<string, string>;
  /** Optional path to a `tsconfig.json` file. */
  readonly tsconfig?: string;
  /** Whether to emit source maps. Defaults to `true`. */
  readonly sourcemap?: boolean;
  /** Cloudflare-specific build options. */
  readonly cloudflare?: Cloudflare;
}

export interface Cloudflare {
  /** Cloudflare Workers compatibility date. */
  readonly compatibilityDate?: string;
  /** Cloudflare Workers compatibility flags such as `nodejs_compat`. */
  readonly compatibilityFlags?: ReadonlyArray<string>;
  /** Rules for additional non-JS modules. */
  readonly additionalModules?: AdditionalModulesOptions;
}

export interface AdditionalModulesOptions {
  readonly rules?: ReadonlyArray<AdditionalModuleRule>;
  readonly preserveFileNames?: boolean;
}

export interface AdditionalModuleRule {
  readonly type: ModuleType;
  readonly globs: ReadonlyArray<string>;
  readonly fallthrough?: boolean;
}
