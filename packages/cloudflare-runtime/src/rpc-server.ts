import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Bindings from "./bindings/index.ts";
import * as Bridge from "./bridge/bridge.ts";
import * as Runtime from "./runtime/runtime.ts";
import * as Server from "./server.ts";
import * as HttpServer from "./utils/http-server.ts";

export class Serve extends Rpc.make("Serve", {
  payload: Server.WorkerInput,
  success: Schema.Struct({
    name: Schema.String,
    address: Schema.String,
  }),
  error: Schema.Union([Runtime.RuntimeError, Bindings.UnsupportedBindingError, Bridge.BridgeError]),
}) {}

export class Close extends Rpc.make("Close", {
  payload: Schema.Struct({ name: Schema.String }),
  error: Bridge.BridgeError,
}) {}

export const WorkersRpc = RpcGroup.make(Serve, Close);

export class ServerOptions extends Context.Service<
  ServerOptions,
  { readonly port: number; readonly storage: string }
>()("@distilled.cloud/cloudflare-runtime/rpc-server/ServerOptions") {}

export const WorkersHandlersLive = WorkersRpc.toLayer(
  Effect.gen(function* () {
    const options = yield* ServerOptions;
    const server = yield* Server.make(options);
    return {
      Serve: (payload) => server.serve(payload),
      Close: (payload) => server.close(payload.name),
    };
  }),
);

export const layerHttp = (options?: { readonly path?: HttpRouter.PathInput }) =>
  RpcServer.layerHttp({
    group: WorkersRpc,
    path: options?.path ?? "/rpc",
    protocol: "http",
  }).pipe(Layer.provide(WorkersHandlersLive), Layer.provide(RpcSerialization.layerMsgPack));

export const serve = Effect.fn(function* (options: {
  readonly rpcPort: number;
  readonly rpcHost?: string;
  readonly path?: HttpRouter.PathInput;
  readonly port: number;
  readonly storage: string;
}) {
  const httpEffect = yield* HttpRouter.toHttpEffect(
    layerHttp({ path: options.path }).pipe(
      Layer.provide(Layer.succeed(ServerOptions, { port: options.port, storage: options.storage })),
    ),
  );
  const http = yield* HttpServer.HttpServer;
  return yield* http.serve(httpEffect, {
    port: options.rpcPort,
    host: options.rpcHost ?? "127.0.0.1",
  });
});

export const clientLayer = (url: string) =>
  RpcClient.layerProtocolHttp({ url }).pipe(
    Layer.provide(RpcSerialization.layerMsgPack),
    Layer.provide(FetchHttpClient.layer),
  );

export const client = (url: string) =>
  RpcClient.make(WorkersRpc).pipe(Effect.provide(clientLayer(url)));
