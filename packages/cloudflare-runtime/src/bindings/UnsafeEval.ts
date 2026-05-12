import * as Effect from "effect/Effect";
import type { BindingHook } from "../PluginContext.ts";
import * as WorkerdConfig from "../workerd/Config.ts";

export const binding = (name: string): BindingHook =>
  Effect.succeed({
    name,
    unsafeEval: WorkerdConfig.kVoid,
  });
