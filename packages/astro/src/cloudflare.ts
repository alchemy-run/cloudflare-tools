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
   * The name of the KV binding injected into Astro's session config when
   * present on the Worker env.
   * @default "SESSION"
   */
  readonly sessionKVBindingName?: string | undefined;
}

export interface AstroCloudflareTarget extends AstroTarget<AstroCloudflareConfig> {}

/**
 * Build the Cloudflare Workers deploy target for Astro.
 *
 * - `integration` — the wrangler-free `@astrojs/cloudflare` fork over
 *   `@distilled.cloud/cloudflare-vite-plugin` (entry env `ssr`, node-side
 *   `astro`/`prerender` environments skipped, node prerendering, passthrough
 *   image service).
 * - `bundle` — workerd resolve conditions + `cloudflare:` externals
 *   (informational for Astro: the integration configures the bundler itself).
 */
export const target = (config: AstroCloudflareConfig = {}): AstroCloudflareTarget =>
  makeDeployTarget({
    platform: "cloudflare",
    config,
    bundle: {
      conditions: ["workerd", "worker", "module", "browser"],
      external: ["cloudflare:"],
    },
    integration: () =>
      distilledCloudflare({
        vite: config.worker,
        sessionKVBindingName: config.sessionKVBindingName,
      }),
  });

export default target;

export {
  distilledCloudflare,
  IMAGE_PASSTHROUGH_ENDPOINT,
  makeIntegrationPluginOptions,
  SERVER_ENTRYPOINT,
  type DistilledCloudflareOptions,
} from "./integration.ts";
