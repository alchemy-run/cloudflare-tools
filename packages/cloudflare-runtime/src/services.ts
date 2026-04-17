import * as Layer from "effect/Layer";
import * as Bindings from "./bindings/index.ts";
import * as Bridge from "./bridge/bridge.ts";
import * as Runtime from "./runtime/runtime.ts";
import * as HttpServer from "./utils/http-server.ts";
import * as Tail from "./utils/tail.ts";

const remoteBindingsServices = Layer.provide(
  Bindings.RemoteBindingsServicesLive,
  Layer.merge(
    Layer.provide(Bindings.RemoteSessionLive, Bindings.AccessLive),
    HttpServer.HttpServerNode,
  ),
);

const bridgeServices = Layer.provide(Bridge.BridgeLive, Tail.TailLive);

export const layer = Layer.provideMerge(
  Layer.merge(remoteBindingsServices, bridgeServices),
  Runtime.RuntimeLive,
);
