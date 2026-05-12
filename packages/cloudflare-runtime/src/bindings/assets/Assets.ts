import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Plugin from "../../Plugin.ts";
import { PluginContext, type BindingHook } from "../../PluginContext.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";

export class Assets extends Plugin.Service<Assets, { isConfigured: boolean }>()(
  "cloudflare-runtime/plugin/Assets",
) {}

export const AssetsLive = Layer.succeed(
  Assets,
  Assets.of(
    PluginContext.useSync(({ worker }) => {
      if (!worker.assets)
        return {
          api: {
            isConfigured: false,
          },
        };
      return {
        services: [
          {
            name: "assets",
            disk: {
              path: worker.assets.directory,
            },
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
            name: "assets",
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
