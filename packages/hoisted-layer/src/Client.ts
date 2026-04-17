import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import type { HoistedDefinition } from "./HoistedLayer.ts";
import type { HoistedLayerAddress } from "./Protocol.ts";

const protocolLayer = (address: HoistedLayerAddress) =>
  RpcClient.layerProtocolHttp({
    url: `http://${address.host}:${address.port}/rpc`,
  }).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Layer.succeed(RpcSerialization.RpcSerialization, RpcSerialization.ndjson)),
  );

export function makeRemoteService(definition: HoistedDefinition<any, any>, address: HoistedLayerAddress) {
  return RpcClient.make(definition.group, { flatten: true }).pipe(
    Effect.map((client) => definition.fromClient(client)),
    Effect.provide(protocolLayer(address)),
  );
}

export function buildLocalService(tag: Context.Service<any, any>, layer: Layer.Layer<any, any, any>) {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const context = yield* Layer.buildWithScope(layer, scope);
    return Context.get(context, tag);
  });
}
