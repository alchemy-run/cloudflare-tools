import { exitHook } from "@alchemy.run/node-utils/exit-hook";
import * as Effect from "effect/Effect";

export const addFinalizer = Effect.fnUntraced(function* <A, E>(input: {
  effect: Effect.Effect<A, E>;
  sync: () => void;
}) {
  const unregister = exitHook(() => {
    try {
      input.sync();
    } catch {
      // ignore errors - best effort
    }
  });
  return yield* Effect.addFinalizer(() =>
    input.effect.pipe(Effect.andThen(Effect.sync(unregister)), Effect.ignore),
  );
});
