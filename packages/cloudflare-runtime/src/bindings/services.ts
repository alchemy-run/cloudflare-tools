import { kVoid, type Service } from "@distilled.cloud/workerd/Config";
import { Context, Layer } from "effect";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Bundle from "../utils/bundle.ts";
import { HttpServer } from "../utils/http-server.ts";
import { RemoteSession, type RemoteSessionOptions } from "./remote-session.ts";

export class RemoteBindingsServices extends Context.Service<
  RemoteBindingsServices,
  {
    readonly services: (options: RemoteSessionOptions) => Effect.Effect<Array<Service>>;
  }
>()("RemoteBindingsServices") {}

export const RemoteBindingsServicesLive = Layer.effect(
  RemoteBindingsServices,
  Effect.gen(function* () {
    const httpServer = yield* HttpServer;
    const remoteSession = yield* RemoteSession;
    const address = yield* httpServer.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const json = (yield* request.json) as unknown as RemoteSessionOptions;
        const session = yield* remoteSession.create(json);
        return yield* HttpServerResponse.json({ success: true, session });
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ success: false, error }, { status: 500 })),
        ),
      ),
      { port: 0 },
    );
    return RemoteBindingsServices.of({
      services: Effect.fn(function* (options) {
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
              {
                name: "OPTIONS",
                json: JSON.stringify(options),
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
