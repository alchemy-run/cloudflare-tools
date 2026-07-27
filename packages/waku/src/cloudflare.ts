/**
 * The Cloudflare Workers deploy target for `@distilled.cloud/waku` — the ONLY
 * module in this package (besides the bundled `./adapter` fork it selects)
 * that imports Cloudflare-specific code. The framework half (`./Waku.ts`)
 * receives this target as a value and stays platform-neutral.
 *
 * Default export: a `(config) => WakuTarget` factory, the shape
 * `resolveDeployTarget` expects from a target module specifier. The config is
 * the cloudflare vite plugin's options (worker name/bindings/assets,
 * compatibility date/flags) — exactly what the e2e harness carries at
 * `target.cloudflare.worker`.
 */
import cloudflareVitePlugin, {
  type CloudflareVitePluginOptions,
} from "@distilled.cloud/cloudflare-vite-plugin";
import { DeployTargetError, makeDeployTarget } from "@distilled.cloud/framework-core";
import * as Effect from "effect/Effect";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { WAKU_SERVER_ENTRY_PATH, type WakuTarget } from "./Waku.ts";

export type { CloudflareVitePluginOptions } from "@distilled.cloud/cloudflare-vite-plugin";
export type { WakuTarget, WakuTargetContext } from "./Waku.ts";

/** Inputs for {@link makeWakuPluginOptions} (exported for testing). */
export interface WakuPluginOptionsInputs {
  /** Directory of the project's installed `waku` package. */
  readonly wakuDirectory: string;
  /** User cloudflare plugin options (the target's config). */
  readonly pluginOptions?: CloudflareVitePluginOptions | undefined;
}

/**
 * Waku requires `AsyncLocalStorage` on the worker runtime (its server entry
 * imports `node:async_hooks` at the top level), so a config without any
 * Node.js compatibility flag would fail at runtime with a module-resolution
 * error. When the user enables neither `nodejs_als` nor
 * `nodejs_compat`/`nodejs_compat_v2` (each of which provides ALS), the
 * target defaults to the minimal `nodejs_als`.
 */
const withNodejsAls = (flags: Array<string> | undefined): Array<string> => {
  const hasAls = flags?.some(
    (flag) => flag === "nodejs_als" || flag === "nodejs_compat" || flag === "nodejs_compat_v2",
  );
  return hasAls ? [...flags!] : [...(flags ?? []), "nodejs_als"];
};

/**
 * The cloudflare plugin options for a waku project: user options with `main`
 * pinned to waku's rsc worker entry, the rsc/ssr environment topology, and
 * `compatibilityFlags` defaulted to include `nodejs_als` (required by waku's
 * server entry) unless the user already enabled ALS or full nodejs_compat.
 *
 * Pinning `main` is mandatory: waku's rsc environment declares two rolldown
 * inputs (`index` + `build`) while the dev plugin asserts exactly one entry.
 */
export const makeWakuPluginOptions = (
  inputs: WakuPluginOptionsInputs,
): CloudflareVitePluginOptions => ({
  ...inputs.pluginOptions,
  main: NodePath.join(inputs.wakuDirectory, WAKU_SERVER_ENTRY_PATH),
  viteEnvironments: { entry: "rsc", children: ["ssr"] },
  compatibilityFlags: withNodejsAls(inputs.pluginOptions?.compatibilityFlags),
});

/**
 * Build the Cloudflare deploy target for waku:
 *
 * - `adapter` — this package's wrangler-free fork of waku's cloudflare
 *   adapter (`@distilled.cloud/waku/adapter`): behavior-identical to upstream
 *   except `buildEnhancers: []`, dropping the sole wrangler-file writer.
 * - `vitePlugins` — `@distilled.cloud/cloudflare-vite-plugin` with `main`
 *   pinned to waku's rsc worker entry and the `{ entry: "rsc", children:
 *   ["ssr"] }` environment topology. Injected inside waku's `vite.plugins`
 *   (before waku's own plugins), so in dev the rsc environment runs in
 *   workerd and the workerd proxy middleware registers ahead of waku's Node
 *   request bridge.
 * - `bundle` — the workerd resolve conditions and `cloudflare:` externals for
 *   any pass that bundles server code for this target.
 */
export const makeWakuCloudflareTarget = (
  config?: CloudflareVitePluginOptions,
): WakuTarget<CloudflareVitePluginOptions | undefined> =>
  makeDeployTarget({
    platform: "cloudflare",
    config,
    bundle: {
      conditions: ["workerd", "worker", "module", "browser"],
      external: ["cloudflare:"],
    },
    adapter: () =>
      Effect.try({
        try: () => fileURLToPath(import.meta.resolve("@distilled.cloud/waku/adapter")),
        catch: (cause) =>
          new DeployTargetError({
            platform: "cloudflare",
            message: "Failed to resolve the @distilled.cloud/waku adapter module",
            cause,
          }),
      }),
    vitePlugins: (context) =>
      Effect.sync(() => [
        cloudflareVitePlugin(
          makeWakuPluginOptions({
            wakuDirectory: context.wakuDirectory,
            pluginOptions: config,
          }),
        ),
      ]),
  });

export default makeWakuCloudflareTarget;
