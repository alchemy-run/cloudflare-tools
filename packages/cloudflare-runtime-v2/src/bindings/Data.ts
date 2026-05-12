import * as Effect from "effect/Effect";
import type { BindingHook } from "../PluginContext";

export const binding = (name: string, data: Uint8Array): BindingHook =>
  Effect.succeed({
    name,
    data,
  });
