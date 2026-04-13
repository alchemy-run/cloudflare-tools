import * as Auth from "@distilled.cloud/cloudflare/Auth";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Bindings from "./bindings";
import * as Bridge from "./bridge/bridge";
import * as Runtime from "./runtime/runtime";
import * as Tail from "./utils/tail";

export const layers = Layer.provideMerge(
  Layer.mergeAll(
    Layer.provide(Bindings.SessionProviderLive, Bindings.AccessLive),
    Layer.provide(Bridge.BridgeLive, Tail.TailLive),
    Runtime.RuntimeLive,
  ),
  Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, Auth.fromEnv()),
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
