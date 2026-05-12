import * as Effect from "effect/Effect";
import type { BindingHook } from "../PluginContext";

export const binding = (name: string): BindingHook =>
  Effect.succeed({
    name,
    json: JSON.stringify({
      id: crypto.randomUUID(),
      tag: "",
      timestamp: "0",
    }),
  });
