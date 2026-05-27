import * as Effect from "effect/Effect";
import * as Loopback from "../globals/Loopback.ts";
import type * as LoopbackServer from "../globals/LoopbackServer.ts";
import * as Plugin from "../Plugin.ts";
import type { BindingHook } from "../PluginContext.ts";

export const local = (
  binding: string,
  handler: LoopbackServer.RouteHandler,
): BindingHook<Loopback.Loopback> =>
  Effect.map(
    Plugin.use(Loopback.Loopback, (loopback) => loopback.api.route(binding, handler)),
    (service) => ({
      name: binding,
      service,
    }),
  );
