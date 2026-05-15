import { parseHeaders, parseRedirects } from "@distilled.cloud/vendor-workers-shared";
import {
  constructHeaders,
  constructRedirects,
} from "@distilled.cloud/vendor-workers-shared/node/configuration/constructConfiguration";
import { parseStaticRouting } from "@distilled.cloud/vendor-workers-shared/shared/configuration/parseStaticRouting";
import type {
  AssetConfig,
  RouterConfig,
  StaticRouting,
} from "@distilled.cloud/vendor-workers-shared/shared/types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AssetsKvWorker from "worker:./assets-kv.worker.ts";
import * as AssetsWorker from "worker:./assets.worker.ts";
import * as RouterWorker from "worker:./router.worker.ts";
import * as Plugin from "../../Plugin.ts";
import { PluginContext, type BindingHook } from "../../PluginContext.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import { moduleToWorkerd } from "../../RuntimeWorker.ts";

export class Assets extends Plugin.Service<Assets, { isConfigured: boolean }>()(
  "cloudflare-runtime/plugin/Assets",
) {}

export const AssetsLive = Layer.succeed(
  Assets,
  Assets.of(
    Effect.gen(function* () {
      const { worker } = yield* PluginContext;
      if (!worker.assets || !worker.assets.directory) {
        return {
          api: {
            isConfigured: false,
          },
        };
      }
      const { encodedAssetManifest, assetsReverseMap } = yield* Effect.never as Effect.Effect<{
        encodedAssetManifest: Uint8Array<ArrayBuffer>;
        assetsReverseMap: Record<string, string>;
      }>;
      let headers: AssetConfig["headers"] | undefined;
      if (worker.assets.headers) {
        const parsedHeaders = parseHeaders(worker.assets.headers);
        headers = constructHeaders({
          headers: parsedHeaders,
          headersFile: worker.assets.headers,
          logger: undefined!,
        }).headers;
      }
      let redirects: AssetConfig["redirects"] | undefined;
      if (worker.assets.redirects) {
        const parsedRedirects = parseRedirects(worker.assets.redirects);
        redirects = constructRedirects({
          redirects: parsedRedirects,
          redirectsFile: worker.assets.redirects,
          logger: undefined!,
        }).redirects;
      }
      let staticRouting: StaticRouting | undefined;
      if (Array.isArray(worker.assets.runWorkerFirst)) {
        staticRouting = parseStaticRouting(worker.assets.runWorkerFirst);
      }
      const routerConfig: RouterConfig = {
        invoke_user_worker_ahead_of_assets: worker.assets.runWorkerFirst !== false,
        static_routing: staticRouting,
        has_user_worker: true,
      };
      const assetsConfig: AssetConfig = {
        compatibility_date: worker.compatibilityDate,
        compatibility_flags: worker.compatibilityFlags,
        html_handling: worker.assets.htmlHandling,
        not_found_handling: worker.assets.notFoundHandling,
        headers,
        redirects,
        has_static_routing: !!staticRouting,
      };
      return {
        services: [
          {
            name: "assets:files",
            disk: {
              path: worker.assets.directory,
            },
          },
          {
            name: "assets:kv",
            worker: {
              compatibilityDate: worker.compatibilityDate,
              compatibilityFlags: worker.compatibilityFlags,
              bindings: [
                {
                  name: "ASSETS_FILES",
                  service: {
                    name: "assets:files",
                  },
                },
                {
                  name: "ASSETS_REVERSE_MAP",
                  json: JSON.stringify(assetsReverseMap),
                },
              ],
              modules: AssetsKvWorker.modules.map(moduleToWorkerd),
            },
          },
          {
            name: "assets:worker",
            worker: {
              compatibilityDate: "2024-07-31",
              compatibilityFlags: ["nodejs_compat", "enable_ctx_exports"],
              bindings: [
                {
                  name: "ASSETS_KV_NAMESPACE",
                  kvNamespace: {
                    name: "assets:kv",
                  },
                },
                {
                  name: "ASSETS_MANIFEST",
                  data: encodedAssetManifest,
                },
                {
                  name: "CONFIG",
                  json: JSON.stringify(assetsConfig),
                },
              ],
              modules: AssetsWorker.modules.map(moduleToWorkerd),
            },
          },
        ],
        middleware: [
          {
            name: "assets:router",
            worker: {
              compatibilityDate: "2024-07-31",
              compatibilityFlags: ["nodejs_compat", "no_nodejs_compat_v2"],
              bindings: [
                {
                  name: "ASSET_WORKER",
                  service: {
                    name: "assets:worker",
                  },
                },
                {
                  name: "CONFIG",
                  json: JSON.stringify(routerConfig),
                },
              ],
              modules: RouterWorker.modules.map(moduleToWorkerd),
            },
            upstreamBindingName: "USER_WORKER",
          },
        ],
        api: {
          isConfigured: true,
        },
      };
    }),
  ),
);

export const binding = (name: string): BindingHook<Assets> =>
  Plugin.use(Assets, (assets) =>
    assets.api.isConfigured
      ? Effect.succeed({
          name,
          service: {
            name: "assets:worker",
          },
        })
      : Effect.fail(
          new ConfigError({
            subtag: "Assets",
            message: "An assets binding cannot be used without worker.assets being specified.",
            hint: "Remove the assets binding or specify worker.assets in your worker config.",
            detail: {
              name,
            },
          }),
        ),
  );
