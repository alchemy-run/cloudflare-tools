import * as Auth from "@distilled.cloud/cloudflare/Auth";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Bindings from "./bindings";
import * as Runtime from "./runtime/runtime";

export const layers = Layer.provideMerge(
  Layer.merge(
    Layer.provide(Bindings.SessionProviderLive, Bindings.AccessLive),
    Runtime.RuntimeLive,
  ),
  Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, Auth.fromEnv()),
);
