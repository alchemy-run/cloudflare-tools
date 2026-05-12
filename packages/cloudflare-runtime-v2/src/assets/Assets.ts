import * as Effect from "effect/Effect";
import * as Plugin from "../Plugin.ts";
import { ConfigError } from "../RuntimeError.shared.ts";

export class Assets extends Plugin.Service<Assets, { serviceName: string; isEnabled: boolean }>()(
  "plugin:Assets",
) {}

export const AssetsLive = Plugin.succeed(
  Assets,
  Assets.of({
    config: (worker, api) => {
      if (!worker.assets) return Effect.succeed({});
      api.isEnabled = true;
      return Effect.succeed({
        services: [
          {
            name: "assets",
            disk: {
              path: worker.assets.directory,
              writable: true,
              allowDotfiles: true,
            },
          },
        ],
      });
    },
    api: {
      serviceName: "assets",
      isEnabled: false,
    },
  }),
);

export const binding = (name: string) =>
  Plugin.use(Assets, (assets) =>
    assets.api.isEnabled
      ? Effect.succeed({
          name,
          service: {
            name: assets.api.serviceName,
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
