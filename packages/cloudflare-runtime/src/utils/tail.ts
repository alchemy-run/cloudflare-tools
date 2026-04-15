import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as LogSync from "./log-sync.ts";

export class TailError extends Data.TaggedError("TailError")<{
  message: string;
  cause?: unknown;
}> {}

export class Tail extends Context.Service<
  Tail,
  {
    readonly connect: (url: string) => Effect.Effect<void, TailError, Scope.Scope>;
    readonly create: (scriptName: string) => Effect.Effect<void, TailError, Scope.Scope>;
  }
>()("Tail") {}

export const TailLive = Layer.effect(
  Tail,
  Effect.gen(function* () {
    const accountId = yield* Config.string("CLOUDFLARE_ACCOUNT_ID");
    const createScriptTail = yield* workers.createScriptTail;
    const deleteScriptTail = yield* workers.deleteScriptTail;
    const logSync = yield* LogSync.make("tail");

    const connect = Effect.fn(function* (url: string) {
      const webSocketUrl = new URL(url);
      webSocketUrl.protocol = webSocketUrl.protocol === "https:" ? "wss:" : "ws:";
      const TRACE_VERSION = "trace-v1";
      const ws = yield* Effect.acquireRelease(
        Effect.callback<WebSocket, TailError>((resume) => {
          const ws = new WebSocket(webSocketUrl.toString(), [TRACE_VERSION]);
          ws.addEventListener("open", () => {
            logSync("Debug", "open");
            resume(Effect.succeed(ws));
          });
          ws.addEventListener("error", (event) => {
            logSync("Error", event);
            resume(
              Effect.fail(new TailError({ message: "Failed to connect to tail", cause: event })),
            );
          });
        }),
        (ws) => Effect.sync(() => ws.close()),
      );
      ws.addEventListener("message", (event) => {
        logSync("Info", JSON.parse(event.data.toString()));
      });
      ws.addEventListener("close", () => {
        logSync("Debug", "close");
      });
    });

    return Tail.of({
      connect,
      create: Effect.fn(function* (scriptName: string) {
        const tail = yield* Effect.acquireRelease(
          createScriptTail({ accountId, scriptName, body: undefined }).pipe(
            Effect.mapError((cause) => new TailError({ message: "Failed to create tail", cause })),
          ),
          (tail) => deleteScriptTail({ accountId, scriptName, id: tail.id }).pipe(Effect.ignore),
        );
        yield* Effect.logDebug("[tail] created", tail);
        yield* connect(tail.url);
      }),
    });
  }),
);
