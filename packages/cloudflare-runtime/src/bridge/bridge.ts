import { kVoid } from "#/runtime/config.types";
import * as Runtime from "#/runtime/runtime";
import * as Bundle from "#/utils/bundle";
import * as Tail from "#/utils/tail";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import { LOCAL_CONFIGURE_PATH, type ProxyControllerMessage } from "./api.shared";

const TAG = "distilled:remote-bridge:2026.04.13-17:02";

export class BridgeError extends Data.TaggedError("BridgeError")<{
  message: string;
  cause?: unknown;
}> {}

export interface LocalBridge {
  readonly configure: (message: ProxyControllerMessage) => Effect.Effect<void, BridgeError>;
}

export class Bridge extends Context.Service<
  Bridge,
  {
    readonly deploy: (scriptName: string) => Effect.Effect<string, BridgeError, Scope.Scope>;
    readonly local: (port: number) => Effect.Effect<LocalBridge, Runtime.RuntimeError, Scope.Scope>;
  }
>()("RemoteBridge") {}

export const BridgeLive = Layer.effect(
  Bridge,
  Effect.gen(function* () {
    const accountId = yield* Config.string("CLOUDFLARE_ACCOUNT_ID");
    const runtime = yield* Runtime.Runtime;
    const tail = yield* Tail.Tail;
    const putScript = yield* workers.putScript;
    const getScript = yield* workers.getScriptSetting;
    const getSubdomain = yield* workers.getSubdomain;
    const createScriptSubdomain = yield* workers.createScriptSubdomain;
    const deleteScript = yield* workers.deleteScript;
    const scope = yield* Effect.scope;

    const subdomain = yield* getSubdomain({ accountId }).pipe(
      Effect.mapError((cause) => new BridgeError({ message: "Failed to get subdomain", cause })),
      Effect.cached,
    );

    yield* Effect.forkDetach(subdomain);

    const deploy = Effect.fn(
      function* (scriptName: string) {
        const existing = yield* getScript({ accountId, scriptName }).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        if (existing?.tags?.includes(TAG)) {
          return;
        }
        const files = yield* Bundle.bundle("src/bridge/remote.worker.ts").pipe(
          Effect.flatMap(Bundle.bundleOutputToFiles),
        );
        yield* putScript({
          scriptName,
          accountId,
          metadata: {
            compatibilityDate: "2026-03-10",
            mainModule: files[0].name,
            bindings: [
              {
                name: "BRIDGE",
                type: "durable_object_namespace",
                className: "RemoteBridge",
              },
            ],
            migrations: existing
              ? undefined
              : {
                  newSqliteClasses: ["RemoteBridge"],
                },
            tags: [TAG],
          },
          files,
        }).pipe(
          Effect.mapError(
            (cause) => new BridgeError({ message: "Failed to deploy remote bridge", cause }),
          ),
        );
        yield* createScriptSubdomain({
          accountId,
          scriptName,
          enabled: true,
        }).pipe(
          Effect.mapError(
            (cause) => new BridgeError({ message: "Failed to create subdomain", cause }),
          ),
        );
        return;
      },
      (effect, scriptName) =>
        Effect.zipWith(
          subdomain,
          effect,
          ({ subdomain }) => `https://${scriptName}.${subdomain}.workers.dev`,
          { concurrent: true },
        ).pipe(
          Effect.tap(() =>
            Effect.addFinalizer(() =>
              Effect.log("Deleting script").pipe(
                Effect.andThen(() => deleteScript({ accountId, scriptName })),
                Effect.tap(() => Effect.log("Deleted script")),
                Effect.ignore,
              ),
            ).pipe(Scope.provide(scope)),
          ),
          Effect.tap(() => Effect.forkDetach(tail.create(scriptName))),
        ),
    );

    const local = Effect.fn(function* (port: number) {
      yield* runtime.serve({
        sockets: [
          {
            name: "http",
            address: `localhost:${port}`,
            service: { name: "bridge:local" },
          },
        ],
        services: [
          {
            name: "bridge:local",
            worker: {
              compatibilityDate: "2026-03-10",
              modules: yield* Bundle.bundle("src/bridge/local.worker.ts").pipe(
                Effect.flatMap(Bundle.bundleOutputToWorkerd),
              ),
              bindings: [{ name: "BRIDGE", durableObjectNamespace: { className: "LocalBridge" } }],
              durableObjectNamespaces: [
                { className: "LocalBridge", ephemeralLocal: kVoid, preventEviction: true },
              ],
            },
          },
          {
            name: "internet",
            network: {
              // Allow access to private/public addresses:
              // https://github.com/cloudflare/miniflare/issues/412
              allow: ["public", "private", "240.0.0.0/4"],
              deny: [],
              tlsOptions: {
                trustBrowserCas: true,
              },
            },
          },
        ],
      });
      return {
        configure: Effect.fn((message: ProxyControllerMessage) =>
          Effect.tryPromise({
            try: async () => {
              console.log("[local] configuring", message);
              const response = await fetch(
                new URL(LOCAL_CONFIGURE_PATH, `http://localhost:${port}`),
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(message),
                },
              );
              return response.ok
                ? ({ ok: true } as const)
                : ({ ok: false, error: await response.text() } as const);
            },
            catch: (error) =>
              new BridgeError({ message: "Failed to configure local bridge", cause: error }),
          }).pipe(
            Effect.flatMap((response) =>
              response.ok
                ? Effect.void
                : Effect.fail(
                    new BridgeError({
                      message: `Failed to configure local bridge: ${response.error}`,
                    }),
                  ),
            ),
            // This indicates an eventual consistency issue, i.e. that the remote worker is not yet ready.
            // Retry aggressively.
            Effect.retry({
              while: (error) =>
                error.message.includes("Failed to establish the WebSocket connection"),
              schedule: Schedule.exponential("500 millis"),
              times: 20,
            }),
          ),
        ),
      } satisfies LocalBridge;
    });

    return Bridge.of({
      deploy,
      local,
    });
  }),
);
