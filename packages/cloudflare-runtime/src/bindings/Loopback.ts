import * as Effect from "effect/Effect";
import * as Loopback from "../globals/Loopback.ts";
import type * as LoopbackServer from "../globals/LoopbackServer.ts";
import * as Plugin from "../Plugin.ts";
import type { BindingHook } from "../PluginContext.ts";

export const binding = (
  name: string,
  handler: LoopbackServer.RouteHandler,
): BindingHook<Loopback.Loopback> =>
  Effect.map(
    Plugin.use(Loopback.Loopback, (loopback) => loopback.api.route(name, handler)),
    (service) => ({
      name,
      service,
    }),
  );
