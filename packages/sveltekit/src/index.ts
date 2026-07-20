/**
 * `@distilled.cloud/sveltekit` — SvelteKit integration for Cloudflare
 * Workers, wrangler-free.
 *
 * The default export is the e2e-harness factory contract: a
 * `(options) => Layer<Framework>` function that reads the shared
 * `options.vite` cloudflare configuration (compatibility date/flags, worker
 * bindings, assets behavior). Use {@link layer} directly for the fully-typed
 * path with SvelteKit-specific options.
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
  appendHeaders,
  generateAssetsIgnore,
  generateHeaders,
  generateRedirects,
  makeCloudflareAdapter,
  makeStubEmulator,
  type CloudflareAdapter,
  type CloudflareAdapterOptions,
  type CloudflareAdapterResult,
} from "./Adapter.ts";
export { layer, make, resolveExportTarget, type SvelteKitOptions } from "./SvelteKit.ts";
export { generateWorkerShim, type WorkerShimOptions } from "./WorkerShim.ts";

/**
 * The structural subset of the e2e harness's `Options` this package reads —
 * by convention, `options.vite` carries the cloudflare worker configuration
 * (`CloudflareVitePluginOptions`). Typed structurally so the package does not
 * depend on the harness.
 */
export interface HarnessOptions {
  readonly vite?:
    | {
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
    | undefined;
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

/** Map the harness's shared options onto {@link SvelteKitOptions}. */
export const fromHarnessOptions = (options: HarnessOptions): SvelteKitOptions => ({
  compatibilityDate: options.vite?.compatibilityDate,
  compatibilityFlags: options.vite?.compatibilityFlags,
  adapter: {
    notFoundHandling: options.vite?.worker?.assets?.notFoundHandling,
  },
  dev: {
    env: resolveDevEnvironment(options.vite?.worker?.bindings),
  },
});

/**
 * The e2e-harness factory contract (`framework: "@distilled.cloud/sveltekit"`
 * in `e2e.config.ts`).
 */
const factory = (
  options: HarnessOptions,
): Layer.Layer<Framework, never, FileSystem.FileSystem | Path.Path> =>
  layer(fromHarnessOptions(options));

export default factory;
