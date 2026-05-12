import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as HttpServerError from "effect/unstable/http/HttpServerError";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type { RuntimeError } from "../RuntimeError.shared.ts";
import { isRuntimeError, SystemError } from "../RuntimeError.shared.ts";
import { makeErrorEnvelope } from "../internal/response.shared.ts";

export class LoopbackServer extends Context.Service<
  LoopbackServer,
  {
    readonly address: string;
    readonly secret: string;
    readonly route: (name: string, handler: RouteHandler) => Effect.Effect<void>;
  }
>()("cloudflare-runtime/LoopbackServer") {}

export type EffectHandler = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  any,
  HttpServerRequest.HttpServerRequest
>;
export type RawHandler = (
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
) => void | Promise<void>;
export type RouteHandler = EffectHandler | RawHandler;

export const LoopbackServerHeaders = {
  TARGET: "loopback-target",
  SECRET: "loopback-secret",
} as const;

export const LoopbackServerLive = Layer.effect(
  LoopbackServer,
  Effect.gen(function* () {
    const routes = MutableHashMap.empty<string, RawHandler>();
    const secret = crypto.randomUUID();
    const server = yield* Effect.sync(() =>
      NodeHttp.createServer(async (req, res) => {
        const secretHeader = req.headers[LoopbackServerHeaders.SECRET] as string | undefined;
        const targetHeader = req.headers[LoopbackServerHeaders.TARGET] as string | undefined;

        if (!secretHeader) {
          return writeErrorResponse(
            res,
            new SystemError({
              subtag: "BadRequest",
              message: `The "${LoopbackServerHeaders.SECRET}" header is required.`,
            }),
            400,
          );
        } else if (!targetHeader) {
          return writeErrorResponse(
            res,
            new SystemError({
              subtag: "BadRequest",
              message: `The "${LoopbackServerHeaders.TARGET}" header is required.`,
            }),
            400,
          );
        } else if (!timingSafeEqual(secretHeader, secret)) {
          return writeErrorResponse(
            res,
            new SystemError({
              subtag: "Unauthorized",
              message: "Unauthorized",
            }),
            401,
          );
        }

        const route = MutableHashMap.get(routes, targetHeader);

        if (route._tag === "None") {
          return writeErrorResponse(
            res,
            new SystemError({
              subtag: "NotFound",
              message: `The route "${targetHeader}" is not found.`,
            }),
            404,
          );
        }

        try {
          await route.value(req, res);
        } catch (error) {
          return writeErrorResponse(
            res,
            isRuntimeError(error)
              ? error
              : new SystemError({
                  subtag: "InternalServerError",
                  message: "Internal Server Error",
                  cause: error,
                }),
            HttpServerError.isHttpServerError(error) ? (error.response?.status ?? 500) : 500,
          );
        }
      }),
    );
    yield* Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));
    const scope = yield* Effect.scope;
    return LoopbackServer.of({
      address: yield* getAddress(server),
      secret,
      route: (name, handler) =>
        Effect.isEffect(handler)
          ? NodeHttpServer.makeHandler(handler, { scope }).pipe(
              Effect.map((handler) => {
                MutableHashMap.set(routes, name, handler);
                return Effect.void;
              }),
            )
          : Effect.sync(() => {
              MutableHashMap.set(routes, name, handler);
              return Effect.void;
            }),
    });
  }),
);

const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) {
    return false;
  }
  return NodeCrypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

const getAddress = (server: NodeHttp.Server): Effect.Effect<string, SystemError> => {
  const address = server.address();
  if (address === null) {
    return Effect.fail(
      new SystemError({
        subtag: "ServerAddressNotAvailable",
        message: "Server address is not available.",
        detail: { server },
      }),
    );
  }
  if (typeof address === "string") {
    return Effect.succeed(address);
  }
  return Effect.succeed(
    `${address.address === "::" ? "0.0.0.0" : address.address}:${address.port}`,
  );
};

const writeErrorResponse = (
  res: NodeHttp.ServerResponse,
  error: RuntimeError,
  status: number = 500,
) => {
  const body = makeErrorEnvelope(error);
  if (!res.headersSent) {
    res.writeHead(status, { "content-type": "application/json" });
  }
  res.end(JSON.stringify(body));
};
