import * as Auth from "@distilled.cloud/cloudflare/Auth";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as http from "node:http";
import * as RuntimeServices from "../dist/RuntimeServices.mjs";
import * as Server from "../dist/Server.mjs";

const services = RuntimeServices.layer({
  host: "localhost",
  port: 0,
  accountId: "1234567890",
}).pipe(
  Layer.provide(
    Layer.merge(
      NodeHttpServer.layerServer(http.createServer, { host: "127.0.0.1", port: 0 }),
      Auth.fromEnv(),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
);

const program = Effect.gen(function* () {
  const server = yield* Server.Server;
  const http = yield* HttpClient.HttpClient;
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
  const response = yield* http.get(new URL("/cdn-cgi/handler/queue", result.address));
  console.log({
    status: response.status,
    body: yield* response.text,
  });
});

await program.pipe(Effect.provide(services), Effect.scoped, Effect.runPromise);
