import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import type net from "node:net";
import { ServerAddressFromNode, ServiceAddress } from "./service-address";

export type Handler = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  HttpServerError.HttpServerError,
  HttpServerRequest.HttpServerRequest
>;

export class HttpServer extends Context.Service<
  HttpServer,
  {
    readonly serve: (
      handler: Handler,
      options?: Partial<ServiceAddress>,
    ) => Effect.Effect<ServiceAddress, ServerError, Scope.Scope>;
  }
>()("HttpServer") {}

export const HttpServerBun = Layer.succeed(HttpServer, {
  serve: Effect.fnUntraced(function* (handler: Handler, options?: Partial<ServiceAddress>) {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: options?.host ?? "127.0.0.1",
          port: options?.port ?? 0,
          fetch: (request) => HttpEffect.toWebHandler(handler)(request),
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    );
    return yield* decodeServerAddress(ServiceAddress, {
      hostname: server.hostname,
      port: server.port,
    });
  }),
});

export const HttpServerNode = Layer.effect(
  HttpServer,
  Effect.gen(function* () {
    const http = yield* Effect.promise(() => import("node:http"));
    return {
      serve: Effect.fnUntraced(function* (handler, options) {
        const scope = yield* Effect.scope;
        const nodeHandler = yield* NodeHttpServer.makeHandler(handler, {
          scope,
        });
        return yield* startNodeServer(http.createServer(nodeHandler), options?.port, options?.host);
      }),
    };
  }),
);

function decodeServerAddress<S extends Schema.Top>(schema: S, value: unknown) {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      (cause) =>
        new ServerError({
          message: `Invalid server address: ${JSON.stringify(value)}`,
          cause,
        }),
    ),
  );
}

export class ServerError extends Schema.TaggedErrorClass<ServerError>()("ServerError", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}

export function startNodeServer<Server extends net.Server>(
  server: Server,
  port: number = 0,
  hostname: string = "127.0.0.1",
) {
  return Effect.acquireRelease(
    Effect.callback<Server, ServerError>((resume) => {
      const onError = (cause: Error) => {
        resume(
          Effect.fail(
            new ServerError({
              message: "Failed to start server",
              cause,
            }),
          ),
        );
      };
      server.once("error", onError);
      server.listen(port, hostname, () => {
        resume(Effect.succeed(server));
      });
      return Effect.sync(() => server.off("error", onError));
    }),
    (server) =>
      Effect.callback((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(Effect.flatMap((server) => decodeServerAddress(ServerAddressFromNode, server.address())));
}
