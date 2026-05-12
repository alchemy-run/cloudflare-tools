import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HyperdriveBindingWorker from "worker:./hyperdrive-binding.worker.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import * as PluginContext from "../../PluginContext.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import type { HyperdriveOrigin } from "./HyperdriveOrigin.shared.ts";

export class Hyperdrive extends Plugin.Service<Hyperdrive, Record<string, HyperdriveOrigin>>()(
  "cloudflare-runtime/plugin/Hyperdrive",
) {}

export const HyperdriveLive = Layer.succeed(
  Hyperdrive,
  Hyperdrive.of(
    PluginContext.useSync(({ worker }) => {
      if (!worker.hyperdrives || Object.keys(worker.hyperdrives).length === 0) return { api: {} };
      return {
        extensions: [
          {
            modules: [
              {
                name: "cloudflare-runtime:hyperdrive",
                internal: true,
                esModule: HyperdriveBindingWorker.modules[0].content as string,
              },
            ],
          },
        ],
        api: worker.hyperdrives,
      };
    }),
  ),
);

export const binding = (name: string, hyperdriveId: string): BindingHook<Hyperdrive> =>
  Plugin.use(Hyperdrive, (hyperdrive) =>
    hyperdrive.api[hyperdriveId]
      ? Effect.succeed({
          name,
          wrapped: {
            moduleName: "cloudflare-runtime:hyperdrive",
            innerBindings: [{ name: "ORIGIN", json: JSON.stringify(hyperdrive.api[hyperdriveId]) }],
          },
        })
      : Effect.fail(
          new ConfigError({
            subtag: "HyperdriveOriginMissing",
            message: `No hyperdrive origin was provided for binding "${name}" (id: ${hyperdriveId}).`,
            hint: `Add an entry for "${hyperdriveId}" to \`worker.hyperdrives\`.`,
            detail: { bindingName: name, hyperdriveId },
          }),
        ),
  );
