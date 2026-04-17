import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Http from "node:http";
import type { HoistedEntry, HostedServer } from "./HoistedLayer.ts";
import { encodeAddressEnv, type HoistedLayerAddress } from "./Protocol.ts";

function mergeLayers(layers: ReadonlyArray<Layer.Layer<any, any, any>>) {
  const [first, ...rest] = layers;
  if (first === undefined) {
    return Layer.empty;
  }
  return rest.length === 0 ? first : Layer.mergeAll(first, ...rest);
}

function mergeGroups(entries: ReadonlyArray<HoistedEntry<any, any, any, any>>) {
  const [first, ...rest] = entries;
  if (first === undefined) {
    return undefined;
  }
  return rest.reduce(
    (group, [definition]) => group.merge(definition.group),
    first[0].group as RpcGroup.RpcGroup<any>,
  );
}

function makeSocketServer(address: Partial<HoistedLayerAddress>) {
  const host = address.host ?? "127.0.0.1";
  const port = address.port ?? 0;
  return NodeHttpServer.layer(Http.createServer, { host, port });
}

export function hostLayers(
  entries: ReadonlyArray<HoistedEntry<any, any, any, any>>,
  options: Partial<HoistedLayerAddress> = {},
) {
  return Effect.gen(function* () {
    if (entries.length === 0) {
      return yield* Effect.die("HoistedLayer.host requires at least one service");
    }

    const handlers = mergeLayers(
      entries.map(([definition, layer]) =>
        Layer.provide(
          definition.group.toLayer(
            Effect.gen(function* () {
              const service = yield* definition.tag;
              return definition.toHandlers(service);
            }),
          ),
          layer,
        ),
      ),
    );

    const group = mergeGroups(entries);
    if (group === undefined) {
      return yield* Effect.die("HoistedLayer.host requires at least one rpc group");
    }

    const scope = yield* Effect.scope;
    const protocolLayer = RpcServer.layerProtocolHttp({ path: "/rpc" }).pipe(
      Layer.provide(HttpRouter.layer),
    );
    const rpcLayer = RpcServer.layer(group).pipe(
      Layer.provide(handlers),
      Layer.provideMerge(protocolLayer),
      Layer.provide(
        HttpRouter.serve(protocolLayer, {
          disableListenLog: true,
          disableLogger: true,
        }),
      ),
      Layer.provideMerge(makeSocketServer(options)),
      Layer.provideMerge(Layer.succeed(RpcSerialization.RpcSerialization, RpcSerialization.ndjson)),
    );

    const context = yield* Layer.buildWithScope(rpcLayer, scope);
    const server = Context.get(context, HttpServer.HttpServer);
    if (server.address._tag !== "TcpAddress") {
      return yield* Effect.die("HoistedLayer.host expected a TCP socket address");
    }

    const address = {
      host: server.address.hostname,
      port: server.address.port,
    } satisfies HoistedLayerAddress;

    return {
      address,
      env: encodeAddressEnv(address),
    } satisfies HostedServer;
  });
}
