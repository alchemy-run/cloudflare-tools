import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";

export class Tail extends Context.Service<
  Tail,
  {
    readonly create: (url: string) => Effect.Effect<void>;
  }
>()("Tail") {}

export const TailLive = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  return Tail.of({
    create: Effect.fn(function* (url: string) {
      const TRACE_VERSION = "trace-v1";
      const ws = yield* Effect.acquireRelease(
        Effect.callback<WebSocket>((resume) => {
          const ws = new WebSocket(url, [TRACE_VERSION]);
          ws.addEventListener("open", () => {
            console.log("[tail] open");
            resume(Effect.succeed(ws));
          });
          ws.addEventListener("error", (event) => {
            console.error("[tail] error", event);
            resume(Effect.die(event));
          });
        }),
        (ws) =>
          Effect.sync(() => {
            console.log("[tail] close");
            ws.close();
          }),
      );
      ws.addEventListener("message", (event) => {
        console.log("[tail] message", event.data.toString());
      });
      ws.addEventListener("close", () => {
        console.log("[tail] close");
      });
    }, Scope.provide(scope)),
  });
});
