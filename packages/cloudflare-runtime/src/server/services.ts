import * as Layer from "effect/Layer";
import * as Bindings from "../bindings/index.ts";
import * as Bridge from "../bridge/bridge.ts";
import * as Runtime from "../runtime/runtime.ts";
import * as Storage from "../storage.ts";
import * as HttpServer from "../utils/http-server.ts";
import * as Tail from "../utils/tail.ts";

const remoteBindingsServices = Layer.provide(
  Bindings.RemoteBindingsServicesLive,
  Layer.merge(
    HttpServer.HttpServerNode,
    Layer.provide(Bindings.RemoteSessionLive, Bindings.AccessLive),
  ),
);

export const layer = (options: { port: number; storage: string }) =>
  Layer.provideMerge(
    Layer.mergeAll(
      remoteBindingsServices,
      Bridge.LocalBridgeLive(options.port),
      Storage.StorageLive(options.storage),
    ),
    Layer.merge(Runtime.RuntimeLive, Tail.TailLive),
  );
