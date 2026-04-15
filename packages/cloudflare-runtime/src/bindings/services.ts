import type { Scope } from "effect";
import { Context, Layer } from "effect";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { kVoid, type Service } from "../runtime/config.types.ts";
import * as Bundle from "../utils/bundle.ts";
import type { ServerError } from "../utils/http-server.ts";
import { HttpServer } from "../utils/http-server.ts";
import { RemoteSession, type RemoteSessionOptions } from "./remote-session.ts";

export class RemoteBindingsServices extends Context.Service<
  RemoteBindingsServices,
  {
    readonly services: (
      options: RemoteSessionOptions,
    ) => Effect.Effect<Array<Service>, ServerError, Scope.Scope>;
  }
>()("RemoteBindingsServices") {}

export const RemoteBindingsServicesLive = Layer.effect(
  RemoteBindingsServices,
  Effect.gen(function* () {
    const httpServer = yield* HttpServer;
    const remoteSession = yield* RemoteSession;
    return RemoteBindingsServices.of({
      services: Effect.fn(function* (options) {
        const address = yield* httpServer.serve(
          remoteSession.create(options).pipe(Effect.flatMap(HttpServerResponse.json), Effect.orDie),
          { port: 0 },
        );
        const config = {
          name: "remote-bindings:config",
          external: {
            address: address.toString(),
            http: {},
          },
        } satisfies Service;
        const outbound = {
          name: "remote-bindings:outbound",
          worker: {
            compatibilityDate: "2026-03-10",
            modules: yield* Bundle.bundle("src/bindings/workers/outbound.worker.ts").pipe(
              Effect.flatMap(Bundle.bundleOutputToWorkerd),
            ),
            bindings: [
              {
                name: "PROXY",
                durableObjectNamespace: { className: "RemoteBindingProxy" },
              },
              {
                name: "LOOPBACK",
                service: { name: config.name },
              },
            ],
            durableObjectNamespaces: [
              {
                className: "RemoteBindingProxy",
                enableSql: true,
                preventEviction: true,
                ephemeralLocal: kVoid,
              },
            ],
          },
        } satisfies Service;
        const client = {
          name: "remote-bindings:client",
          worker: {
            compatibilityDate: "2026-03-10",
            modules: yield* Bundle.bundle("src/bindings/workers/client.worker.ts").pipe(
              Effect.flatMap(Bundle.bundleOutputToWorkerd),
            ),
            globalOutbound: { name: outbound.name },
          },
        } satisfies Service;
        return [client, outbound, config];
      }),
    });
  }),
);
