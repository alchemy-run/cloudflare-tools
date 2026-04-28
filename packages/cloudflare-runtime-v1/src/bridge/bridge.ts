import * as workers from "@distilled.cloud/cloudflare/workers";
import { kVoid } from "@distilled.cloud/workerd/Config";
import * as Runtime from "@distilled.cloud/workerd/Runtime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpBody, HttpClientResponse } from "effect/unstable/http";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Bundle from "../utils/bundle.ts";
import { findAvailablePort } from "../utils/is-port-available.ts";
import * as Tail from "../utils/tail.ts";
import { LOCAL_CONFIGURE_PATH, type ProxyControllerMessage } from "./api.shared.ts";

const TAG = "distilled:remote-bridge:2026.04.13-17:02";

export class BridgeError extends Schema.TaggedErrorClass<BridgeError>()("BridgeError", {
  message: Schema.String,
  cause: Schema.optional(Schema.DefectWithStack),
}) {}

export class LocalBridge extends Context.Service<
  LocalBridge,
  {
    readonly port: number;
    readonly send: (message: ProxyControllerMessage) => Effect.Effect<void, BridgeError>;
  }
>()("LocalBridge") {}

export const LocalBridgeLive = (userPort: number) =>
  Layer.effect(
    LocalBridge,
    Effect.gen(function* () {
      const runtime = yield* Runtime.Runtime;
      const httpClient = yield* HttpClient.HttpClient;
      const port = yield* findAvailablePort(userPort, "localhost");
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
      return LocalBridge.of({
        port,
        send: Effect.fn((message) =>
          httpClient
            .post(new URL(LOCAL_CONFIGURE_PATH, `http://localhost:${port}`), {
              body: HttpBody.jsonUnsafe(message),
            })
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.mapError(
                (e) =>
                  new BridgeError({ message: "Failed to send message to local bridge", cause: e }),
              ),
            ),
        ),
      });
    }),
  );

export class RemoteBridge extends Context.Service<
  RemoteBridge,
  {
    readonly deploy: (
      scriptName: string,
      accountId: string,
    ) => Effect.Effect<string, BridgeError, Scope.Scope>;
  }
>()("RemoteBridge") {}

export const RemoteBridgeLive = Layer.effect(
  RemoteBridge,
  Effect.gen(function* () {
    const tail = yield* Tail.Tail;
    const putScript = yield* workers.putScript;
    const getScript = yield* workers.getScriptSetting;
    const getSubdomain = yield* workers.getSubdomain;
    const createScriptSubdomain = yield* workers.createScriptSubdomain;
    const deleteScript = yield* workers.deleteScript;
    const scope = yield* Effect.scope;

    const deploy = Effect.fn(
      function* (scriptName: string, accountId: string) {
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
      (effect, scriptName, accountId) =>
        Effect.zipWith(
          getSubdomain({ accountId }).pipe(
            Effect.mapError(
              (cause) => new BridgeError({ message: "Failed to get subdomain", cause }),
            ),
          ),
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

    return RemoteBridge.of({
      deploy,
    });
  }),
);
