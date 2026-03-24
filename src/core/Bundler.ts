import type * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";
import type * as AdditionalModules from "./AdditionalModules.js";
import type { BundleError } from "./Error.js";
import type { Output } from "./Output.js";

export interface Cloudflare {
  /** Cloudflare Workers compatibility date. */
  readonly compatibilityDate?: string;
  /** Cloudflare Workers compatibility flags such as `nodejs_compat`. */
  readonly compatibilityFlags?: ReadonlyArray<string>;
  /** Rules for additional non-JS modules. */
  readonly additionalModules?: AdditionalModules.Options;
}

export interface Options {
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

export class Bundler extends ServiceMap.Service<
  Bundler,
  {
    readonly build: (options: Options) => Effect.Effect<Output, BundleError>;
  }
>()("@distilled.cloud/cloudflare-bundler/Bundler") {}
