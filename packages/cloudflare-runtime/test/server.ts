import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Server from "../dist/Server.mjs";
import * as Storage from "../dist/Storage.mjs";
import * as LocalProxy from "../dist/proxy/LocalProxy.mjs";
import * as Runtime from "../dist/workerd/Runtime.mjs";

const services = Server.layer.pipe(
  Layer.provideMerge(LocalProxy.layerLive({ host: "localhost", port: 0 })),
  Layer.provide(Layer.merge(Runtime.layer, Storage.layerTemp())),
  Layer.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
);

const program = Effect.gen(function* () {
  const server = yield* Server.Server;
  const result = yield* server.serve({
    name: "test",
    compatibilityDate: "2026-03-10",
    compatibilityFlags: [],
    bindings: [],
    modules: [
      {
        name: "test.js",
        type: "ESModule",
        content: "export default { fetch: () => new Response('Hello, world!') };",
      },
    ],
  });
  console.log(result);
});

await program.pipe(Effect.provide(services), Effect.scoped, Effect.runPromise);
