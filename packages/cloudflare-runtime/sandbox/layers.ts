import * as Auth from "@distilled.cloud/cloudflare/Auth";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Bindings from "../src/bindings/index.ts";
import * as Bridge from "../src/bridge/bridge.ts";
import * as Runtime from "../src/runtime/runtime.ts";
import * as HttpServer from "../src/utils/http-server.ts";
import * as Tail from "../src/utils/tail.ts";

const remoteBindingsServices = Layer.provide(
  Bindings.RemoteBindingsServicesLive,
  Layer.merge(
    Layer.provide(Bindings.RemoteSessionLive, Bindings.AccessLive),
    HttpServer.HttpServerNode,
  ),
);

const bridgeServices = Layer.provide(Bridge.BridgeLive, Tail.TailLive);

const coreServices = Layer.provideMerge(
  Runtime.RuntimeLive,
  Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, Auth.fromEnv()),
);

export const layers = Layer.provideMerge(
  Layer.merge(remoteBindingsServices, bridgeServices),
  coreServices,
);

export function run<A, E>(program: Effect.Effect<A, E>) {
  const controller = new AbortController();
  process.on("SIGINT", () => {
    controller.abort();
  });
  return Effect.runPromise(program, {
    signal: controller.signal,
  });
}
