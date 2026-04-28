import * as Effect from "effect/Effect";
import type { Severity } from "effect/LogLevel";

export const make = Effect.fn(function* (prefix: string) {
  const context = yield* Effect.context();
  return (level: Severity, ...args: Array<unknown>) =>
    Effect.logWithLevel(level)(`[${prefix}]`, ...args).pipe(
      Effect.provide(context),
      Effect.runSync,
    );
});
