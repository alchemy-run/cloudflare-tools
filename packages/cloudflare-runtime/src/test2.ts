import * as Auth from "@distilled.cloud/cloudflare/Auth";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Bindings from "./bindings";
import * as Runtime from "./runtime/runtime";
import { bundleAsEsModule } from "./utils/bundle";

const program = Effect.gen(function* () {
  const runtime = yield* Runtime.Runtime;
  const bindings = yield* Bindings.WorkerLive({
    accountId: yield* Config.string("CLOUDFLARE_ACCOUNT_ID"),
    scriptName: "remote-bindings",
    bindings: [
      {
        name: "KV",
        type: "kv_namespace",
        namespaceId: "c2399b3754ea4199a765e8c388eb2603",
        raw: true,
      },
    ],
  });
  const server = yield* runtime.serve({
    sockets: [
      {
        name: "user",
        address: "localhost:1337",
        service: { name: "user" },
      },
    ],
    services: [
      {
        name: "user",
        worker: {
          compatibilityDate: "2026-03-10",
          modules: [yield* bundleAsEsModule("src/workers/hello-world.worker.ts")],
          bindings: [
            {
              name: "KV",
              kvNamespace: bindings.make("KV"),
            },
          ],
        },
      },
      ...bindings.services,
    ],
  });
  yield* Effect.log(server);
  yield* Effect.never;
});

export const layers = Layer.provideMerge(
  Layer.merge(
    Layer.provide(Bindings.SessionProviderLive, Bindings.AccessLive),
    Runtime.RuntimeLive,
  ),
  Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, Auth.fromEnv()),
);

// const controller = new AbortController();
// process.on("SIGINT", () => {
//   controller.abort();
// });

// await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(layers)), {
//   signal: controller.signal,
// });
