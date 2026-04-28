import * as Runtime from "@distilled.cloud/workerd/Runtime";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Layer from "effect/Layer";
import * as http from "node:http";
import * as Bindings from "../bindings/index.ts";
import * as Bridge from "../bridge/bridge.ts";
import * as Storage from "../storage.ts";
import * as Tail from "../utils/tail.ts";

const remoteBindingsServices = Layer.provide(
  Bindings.RemoteBindingsServicesLive,
  Layer.provideMerge(
    Bindings.RemoteSessionLive,
    Layer.mergeAll(
      Bindings.AccessLive,
      NodeHttpServer.layerServer(http.createServer, { host: "127.0.0.1", port: 0 }),
    ),
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
