/**
 * The Cloudflare Workers deploy target for `@distilled.cloud/astro`
 * (`@distilled.cloud/astro/cloudflare`).
 *
 * This module is the ONLY seam between the Astro framework module and
 * Cloudflare: it owns the wrangler-free `@astrojs/cloudflare` fork (the
 * integration over `@distilled.cloud/cloudflare-vite-plugin`, its vendored
 * server entrypoints, workerd dev via the vite module runner) and exposes it
 * through the `AstroTarget` contract. The framework module
 * (`Astro.ts`/`index.ts`) never imports anything Cloudflare-specific — it
 * receives this target as a value (or resolves this module by specifier when
 * no target is given).
 *
 * The default export is the target factory the framework's target resolution
 * applies to the caller's config (`resolveDeployTarget`); the named exports
 * re-expose the underlying integration surface for direct/advanced use.
 */
import type { CloudflareVitePluginOptions } from "@distilled.cloud/cloudflare-vite-plugin";
import { makeDeployTarget } from "@distilled.cloud/framework-core";
import * as Effect from "effect/Effect";
import * as NodePath from "node:path";
import { distilledCloudflare } from "./integration.ts";
import type { AstroTarget } from "./Target.ts";

/**
 * Cloudflare target configuration. Matches the e2e harness's target-scoped
 * carriage (`target.cloudflare.worker`): `worker` is the full
 * `CloudflareVitePluginOptions` shape (compatibility date/flags, worker
 * name/bindings/assets, runtime context).
 */
export interface AstroCloudflareConfig {
  /**
   * Options forwarded to `@distilled.cloud/cloudflare-vite-plugin`
   * (compatibility date/flags, worker name/bindings/assets, runtime
   * context). `main`, `viteEnvironments`, and Astro's node-side
   * environments in `skipEnvironments` are managed by the integration.
   */
  readonly worker?: CloudflareVitePluginOptions | undefined;
  /**
   * Which runtime prerenders static pages at build time: `'workerd'`
   * (default) renders them inside the production runtime via the built
   * `prerender` environment worker; `'node'` falls back to Astro's stock
   * node prerenderer. See `DistilledCloudflareOptions.prerenderEnvironment`.
   * @default "workerd"
   */
  readonly prerenderEnvironment?: "workerd" | "node" | undefined;
  /**
   * The name of the KV binding injected into Astro's session config when
   * present on the Worker env.
   * @default "SESSION"
   */
  readonly sessionKVBindingName?: string | undefined;
  /**
   * Zero-config sessions: default Astro's session driver to Cloudflare KV
   * (binding `sessionKVBindingName`) when none is configured. `false` leaves
   * the session config untouched.
   * @default true
   */
  readonly sessions?: boolean | undefined;
  /**
   * In dev, auto-inject an in-memory local KV namespace for the session
   * binding. Disable when the dev worker bindings already carry a KV binding
   * with that name.
   * @default true
   */
  readonly sessionDevKV?: boolean | undefined;
}

export interface AstroCloudflareTarget extends AstroTarget<AstroCloudflareConfig> {}

/**
 * Build the Cloudflare Workers deploy target for Astro.
 *
 * - `integration` — the wrangler-free `@astrojs/cloudflare` fork over
 *   `@distilled.cloud/cloudflare-vite-plugin` (entry env `ssr`, node-side
 *   `astro` environment skipped, workerd prerendering by default with a
 *   `'node'` fallback, passthrough image service).
 * - `bundle` — workerd resolve conditions + `cloudflare:` externals
 *   (informational for Astro: the integration configures the bundler itself).
 */
export const target = (config: AstroCloudflareConfig = {}): AstroCloudflareTarget => {
  // Written by the integration's `astro:config:done` (the client directory
  // before the `base !== "/"` remap nests it); read by `finish` below.
  let originalClientDir: string | undefined;
  return makeDeployTarget({
    platform: "cloudflare",
    config,
    bundle: {
      conditions: ["workerd", "worker", "module", "browser"],
      external: ["cloudflare:"],
    },
    integration: () =>
      distilledCloudflare({
        vite: config.worker,
        prerenderEnvironment: config.prerenderEnvironment,
        sessionKVBindingName: config.sessionKVBindingName,
        sessions: config.sessions,
        sessionDevKV: config.sessionDevKV,
        onOriginalClientDir: (dir) => {
          // Normalize (drop the directory-URL trailing slash) so the
          // comparison with the collector's `resolve`d path is exact.
          originalClientDir = NodePath.resolve(dir);
        },
      }),
    // With `base !== "/"` the client build is nested under the base
    // (`dist/client/<base>/`), so the collector captures the nested
    // directory. The directory that must be served at the URL root is the
    // original one — the in-memory equivalent of upstream's emitted
    // wrangler.json `assets.directory` patch.
    finish: (output) =>
      Effect.succeed(
        originalClientDir !== undefined &&
          output.clientDirectory !== undefined &&
          output.clientDirectory !== originalClientDir
          ? { ...output, clientDirectory: originalClientDir }
          : output,
      ),
  });
};

export default target;

export {
  distilledCloudflare,
  IMAGE_PASSTHROUGH_ENDPOINT,
  makeIntegrationPluginOptions,
  SERVER_ENTRYPOINT,
  usesCloudflareKVSessionDriver,
  withDevSessionKv,
  type DistilledCloudflareOptions,
} from "./integration.ts";
