import { kVoid, type Service } from "#/runtime/config.types";
import * as Bundle from "#/utils/bundle";
import * as Tail from "#/utils/tail";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { LOCAL_CONFIGURE_PATH } from "./api.shared";

const TAG = "distilled:remote-bridge:2026.04.13-17:02";

export class BridgeError extends Data.TaggedError("BridgeError")<{
  message: string;
  cause?: unknown;
}> {}

export class Bridge extends Context.Service<
  Bridge,
  {
    readonly deploy: (scriptName: string) => Effect.Effect<string, BridgeError, Scope.Scope>;
    readonly local: (userWorkerName: string) => Effect.Effect<Service, BridgeError>;
    readonly configure: (local: string, remote: string) => Effect.Effect<void, BridgeError>;
  }
>()("RemoteBridge") {}

export const BridgeLive = Layer.effect(
  Bridge,
  Effect.gen(function* () {
    const accountId = yield* Config.string("CLOUDFLARE_ACCOUNT_ID");
    const tail = yield* Tail.Tail;
    const putScript = yield* workers.putScript;
    const getScript = yield* workers.getScriptSetting;
    const getSubdomain = yield* workers.getSubdomain;
    const createScriptSubdomain = yield* workers.createScriptSubdomain;

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
        ).pipe(Effect.tap(() => Effect.forkDetach(tail.create(scriptName)))),
    );

    const local = Effect.fn(function* (userWorkerName: string) {
      return {
        name: "bridge:local",
        worker: {
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [
            "experimental",
            "enable_request_signal",
            "service_binding_extra_handlers",
          ],
          modules: yield* Bundle.bundle("src/bridge/local.worker.ts").pipe(
            Effect.flatMap(Bundle.bundleOutputToWorkerd),
          ),
          bindings: [
            { name: "USER_WORKER", service: { name: userWorkerName } },
            { name: "BRIDGE", durableObjectNamespace: { className: "LocalBridge" } },
          ],
          durableObjectNamespaces: [
            { className: "LocalBridge", ephemeralLocal: kVoid, preventEviction: true },
          ],
        },
      } satisfies Service;
    });

    const configure = Effect.fn((local: string, remote: string) =>
      Effect.tryPromise({
        try: async () => {
          const localUrl = new URL(LOCAL_CONFIGURE_PATH, local);
          const response = await fetch(localUrl, {
            method: "POST",
            body: JSON.stringify({ remote }),
          });
          return response.ok
            ? ({ ok: true } as const)
            : ({ ok: false, error: await response.text() } as const);
        },
        catch: (error) =>
          new BridgeError({ message: "Failed to fetch local bridge", cause: error }),
      }).pipe(
        Effect.flatMap((response) =>
          response.ok
            ? Effect.void
            : Effect.fail(
                new BridgeError({
                  message: `Failed to configure bridge: ${response.error}`,
                }),
              ),
        ),
        Effect.tap(() => Effect.logDebug("Bridge configured")),
      ),
    );

    return Bridge.of({
      deploy,
      local,
      configure,
    });
  }),
);
