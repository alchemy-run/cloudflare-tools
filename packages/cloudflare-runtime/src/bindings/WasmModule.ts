import * as Effect from "effect/Effect";
import type { BindingHook } from "../PluginContext.ts";

export const binding = (name: string, wasmModule: Uint8Array): BindingHook =>
  Effect.succeed({
    name,
    wasmModule,
  });
