import * as Effect from "effect/Effect";
import type { BindingHook } from "../PluginContext.ts";
import { PluginContext } from "../PluginContext.ts";
import { ConfigError } from "../RuntimeError.shared.ts";

export const local = (name: string, className: string): BindingHook =>
  PluginContext.use(({ worker }) => {
    if (!worker.durableObjectNamespaces?.find((namespace) => namespace.className === className)) {
      return Effect.fail(
        new ConfigError({
          subtag: "DurableObjectNamespaceNotFound",
          message: `Durable object namespace ${className} not found`,
          hint: `Make sure the durable object namespace ${className} is defined in the worker config`,
          detail: { className },
        }),
      );
    }
    return Effect.succeed({
      name,
      durableObjectNamespace: { className },
    });
  });
