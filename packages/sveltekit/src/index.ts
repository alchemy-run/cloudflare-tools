/**
 * `@distilled.cloud/sveltekit` — SvelteKit integration implementing
 * framework-core's `Framework` service, with the deploy target passed as a
 * value (Cloudflare Workers by default, via the
 * `@distilled.cloud/sveltekit/cloudflare` subpath module).
 *
 * The default export is the e2e-harness factory contract: a
 * `(options) => Layer<Framework>` function that reads the harness's
 * cloudflare-target configuration (compatibility date/flags, worker bindings,
 * assets behavior). Use {@link layer} directly for the fully-typed path with
 * SvelteKit-specific options.
 *
 * This module (and `SvelteKit.ts`) is target-agnostic by contract: it must
 * not import anything Cloudflare-specific. The Cloudflare half — the
 * in-memory kit adapter fork, the workerd rolldown finishing pass, the dev
 * stub platform — lives behind `@distilled.cloud/sveltekit/cloudflare`.
 */
import type { Framework } from "@distilled.cloud/framework-core";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import { layer, type SvelteKitOptions } from "./SvelteKit.ts";

export {
  DEFAULT_TARGET_SPECIFIER,
  layer,
  make,
  resolveExportTarget,
  type SvelteKitAdapter,
  type SvelteKitAdapterContext,
  type SvelteKitAdapterOptions,
  type SvelteKitAdapterResult,
  type SvelteKitOptions,
  type SvelteKitTarget,
  type SvelteKitTargetConfig,
  type SvelteKitTargetInput,
} from "./SvelteKit.ts";

/**
 * The structural subset of the e2e harness's cloudflare worker options this
 * package reads (`CloudflareVitePluginOptions`). Typed structurally so the
 * package does not depend on the harness.
 */
export interface HarnessWorkerOptions {
  readonly compatibilityDate?: string | undefined;
  readonly compatibilityFlags?: Array<string> | undefined;
  readonly worker?:
    | {
        readonly bindings?: ReadonlyArray<unknown> | undefined;
        readonly assets?:
          | {
              readonly notFoundHandling?:
                | "none"
                | "404-page"
                | "single-page-application"
                | undefined;
            }
          | undefined;
      }
    | undefined;
}

/**
 * The structural subset of the e2e harness's `Options` this package reads.
 * The harness carries cloudflare configuration target-scoped
 * (`target.cloudflare.worker`); the top-level `vite` field is the harness's
 * deprecated alias for the same shape (target-scoped wins).
 */
export interface HarnessOptions {
  readonly target?:
    | {
        readonly cloudflare?:
          | {
              readonly worker?: HarnessWorkerOptions | undefined;
            }
          | undefined;
      }
    | undefined;
  /** @deprecated Harness alias for `target.cloudflare.worker`. */
  readonly vite?: HarnessWorkerOptions | undefined;
}

/**
 * Derive the dev-server stub `platform.env` from the worker's declared
 * binding hooks. Binding hooks are Effects producing workerd `Worker_Binding`
 * configs; the ones that resolve synchronously without runtime services (Text
 * and Json bindings) become plain env values. Everything else (KV, R2, D1,
 * ...) is skipped — dev runs SvelteKit's Node SSR, where real Cloudflare
 * bindings are unavailable until the cloudflare-runtime Node-side bindings
 * proxy lands.
 */
export const resolveDevEnvironment = (
  bindings: ReadonlyArray<unknown> | undefined,
): Record<string, unknown> => {
  const env: Record<string, unknown> = {};
  for (const hook of bindings ?? []) {
    if (!Effect.isEffect(hook)) continue;
    const exit = Effect.runSyncExit(hook as Effect.Effect<unknown, unknown, never>);
    if (!Exit.isSuccess(exit)) continue;
    const binding = exit.value;
    if (!Predicate.hasProperty(binding, "name") || typeof binding.name !== "string") continue;
    if (Predicate.hasProperty(binding, "text") && typeof binding.text === "string") {
      env[binding.name] = binding.text;
    } else if (Predicate.hasProperty(binding, "json") && typeof binding.json === "string") {
      try {
        env[binding.name] = JSON.parse(binding.json);
      } catch {
        // not valid JSON — skip
      }
    }
  }
  return env;
};

/**
 * Map the harness's options onto {@link SvelteKitOptions}, preferring the
 * target-scoped carriage (`target.cloudflare.worker`) over the deprecated
 * top-level `vite` alias.
 */
export const fromHarnessOptions = (options: HarnessOptions): SvelteKitOptions => {
  const worker = options.target?.cloudflare?.worker ?? options.vite;
  return {
    compatibilityDate: worker?.compatibilityDate,
    compatibilityFlags: worker?.compatibilityFlags,
    adapter: {
      notFoundHandling: worker?.worker?.assets?.notFoundHandling,
    },
    dev: {
      env: resolveDevEnvironment(worker?.worker?.bindings),
    },
  };
};

/**
 * The e2e-harness factory contract (`framework: "@distilled.cloud/sveltekit"`
 * in `e2e.config.ts`).
 */
const factory = (
  options: HarnessOptions,
): Layer.Layer<Framework, never, FileSystem.FileSystem | Path.Path> =>
  layer(fromHarnessOptions(options));

export default factory;
