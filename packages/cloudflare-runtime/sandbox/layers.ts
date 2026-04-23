import * as Auth from "@distilled.cloud/cloudflare/Auth";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

export const layers =
  // Layer.provideMerge(
  // Services.layer({ port: 1337, storage: ".cache/local" }),
  Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, Auth.fromEnv());
// );

export function run<A, E>(program: Effect.Effect<A, E>) {
  const controller = new AbortController();
  process.on("SIGINT", () => {
    controller.abort();
  });
  return Effect.runPromise(program, {
    signal: controller.signal,
  });
}
