import * as Effect from "effect/Effect";
import type { BindingHook } from "../PluginContext";

export const binding = (name: string, json: any): BindingHook =>
  Effect.succeed({
    name,
    json: JSON.stringify(json),
  });
