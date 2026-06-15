import type { CloudflarePluginOptions } from "@distilled.cloud/cloudflare-rolldown-plugin/options";
import type {
  Assets as RuntimeAssets,
  BindingHooks,
  RuntimeServices,
  RuntimeWorker,
} from "@distilled.cloud/cloudflare-runtime";
import type * as Context from "effect/Context";

const ASSET_ROUTING_KEYS = ["htmlHandling", "notFoundHandling", "runWorkerFirst"] as const;

export type CloudflareViteAssetsOptions = Pick<RuntimeAssets, (typeof ASSET_ROUTING_KEYS)[number]>;

export type CloudflareViteWorkerOptions<B extends BindingHooks = BindingHooks> = Partial<
  Omit<RuntimeWorker<B>, "compatibilityDate" | "compatibilityFlags" | "modules" | "assets">
> & {
  /**
   * Advanced asset runtime options. In Vite mode the asset directory is always
   * derived from the client build output; prefer the top-level `assets`
   * shorthand for routing options such as SPA fallback.
   */
  assets?: RuntimeAssets;
};

export interface CloudflareVitePluginOptions<
  B extends BindingHooks = BindingHooks,
> extends CloudflarePluginOptions {
  /**
   * Asset routing options for the Vite-managed client output. The output
   * directory is inferred from Vite and must not be configured here.
   */
  assets?: CloudflareViteAssetsOptions;
  worker?: CloudflareViteWorkerOptions<B>;
  context?: Context.Context<RuntimeServices>;
}

export function normalizeCloudflareVitePluginOptions<B extends BindingHooks = BindingHooks>(
  options: CloudflareVitePluginOptions<B>,
): CloudflareVitePluginOptions<B> {
  const assets = mergeAssetRoutingOptions(options.assets, options.worker?.assets);
  if (!assets) return options;

  return {
    ...options,
    assets,
    worker: {
      ...options.worker,
      assets: {
        ...options.worker?.assets,
        ...assets,
      },
    },
  };
}

function mergeAssetRoutingOptions(
  topLevelAssets: CloudflareViteAssetsOptions | undefined,
  workerAssets: RuntimeAssets | undefined,
): CloudflareViteAssetsOptions | undefined {
  const pickedWorkerAssets = pickAssetRoutingOptions(workerAssets);
  const hasTopLevelAssets = hasAssetRoutingOptions(topLevelAssets);
  const hasWorkerAssets = hasAssetRoutingOptions(pickedWorkerAssets);

  if (!hasTopLevelAssets && !hasWorkerAssets) return undefined;

  for (const key of ASSET_ROUTING_KEYS) {
    const topLevelValue = topLevelAssets?.[key];
    const workerValue = pickedWorkerAssets?.[key];
    if (
      topLevelValue !== undefined &&
      workerValue !== undefined &&
      !assetRoutingValuesEqual(topLevelValue, workerValue)
    ) {
      throw new Error(
        `[cloudflare] assets.${key} is configured both at the top level and ` +
          `under worker.assets with different values. Use one location for asset routing options.`,
      );
    }
  }

  return {
    ...pickedWorkerAssets,
    ...topLevelAssets,
  };
}

function pickAssetRoutingOptions(
  assets: RuntimeAssets | undefined,
): CloudflareViteAssetsOptions | undefined {
  if (!assets) return undefined;

  return Object.fromEntries(
    ASSET_ROUTING_KEYS.flatMap((key) => {
      const value = assets[key];
      return value === undefined ? [] : [[key, value]];
    }),
  ) as CloudflareViteAssetsOptions;
}

function hasAssetRoutingOptions(assets: CloudflareViteAssetsOptions | undefined) {
  return ASSET_ROUTING_KEYS.some((key) => assets?.[key] !== undefined);
}

function assetRoutingValuesEqual(
  a: CloudflareViteAssetsOptions[(typeof ASSET_ROUTING_KEYS)[number]],
  b: CloudflareViteAssetsOptions[(typeof ASSET_ROUTING_KEYS)[number]],
) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => value === b[index])
    );
  }
  return a === b;
}
