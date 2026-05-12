import * as Effect from "effect/Effect";
import type { BindingHook } from "../PluginContext";

export const binding = (name: string, text: string): BindingHook =>
  Effect.succeed({
    name,
    text,
  });
