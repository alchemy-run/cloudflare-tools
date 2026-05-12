import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as ConfigBuilder from "./ConfigBuilder.ts";
import type { RuntimeError } from "./RuntimeError.shared.ts";
import type { RuntimeWorker } from "./RuntimeWorker.ts";
import * as Workerd from "./workerd/Workerd.ts";

export class Runtime extends Context.Service<
  Runtime,
  {
    readonly start: <E, R>(
      worker: RuntimeWorker<E, R>,
    ) => Effect.Effect<void, E | RuntimeError, R | Scope.Scope>;
  }
>()("cloudflare-runtime/Runtime") {}

export const RuntimeLive = Layer.effect(
  Runtime,
  Effect.gen(function* () {
    const workerd = yield* Workerd.Workerd;

    return Runtime.of({
      start: Effect.fn(function* (worker) {
        const config = yield* ConfigBuilder.build(worker);
        const result = yield* workerd.serve(config);
        return result;
      }),
    });
  }),
);
