import * as Effect from "effect/Effect";
import { group, LayerNotFound, MethodNotFound } from "./protocol.ts";

export const server = group.toLayer(
  Effect.gen(function* () {
    const context = yield* Effect.context();
    return group.of({
      heartbeat: () => Effect.void,
      validate: (payload) => {
        if (context.mapUnsafe.has(payload.layer)) {
          return Effect.void;
        }
        return Effect.fail(
          new LayerNotFound({ message: `Layer ${payload.layer} not found`, layer: payload.layer }),
        );
      },
      call: Effect.fnUntraced(function* (payload) {
        const layer = context.mapUnsafe.get(payload.layer);
        if (!layer) {
          return yield* new LayerNotFound({
            message: `Layer ${payload.layer} not found`,
            layer: payload.layer,
          });
        }
        if (!(payload.method in layer) || typeof layer[payload.method] !== "function") {
          return yield* new MethodNotFound({
            message: `Method ${payload.method} not found`,
            layer: payload.layer,
            method: payload.method,
          });
        }
        const effect = yield* Effect.exit(layer[payload.method](...payload.args));
        return effect;
      }),
    });
  }),
);
