import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Runtime from "./runtime";

Bun.serve({
  port: 9898,
  fetch: async (request) => {
    return new Response("Hello from Bun!", { status: 200 });
  },
});

const program = Effect.gen(function* () {
  const runtime = yield* Runtime.Runtime;
  const result = yield* runtime.serve({
    sockets: [
      {
        name: "http",
        address: "127.0.0.1:3002",
        service: {
          name: "worker",
        },
      },
    ],
    services: [
      {
        name: "worker",
        worker: {
          compatibilityDate: "2026-03-10",
          modules: [
            {
              name: "worker",
              esModule: `export default { fetch: async (request, env) => {
              return env.TEST.fetch(request);
              } }`,
            },
          ],
          bindings: [{ name: "TEST", service: { name: "rpc" } }],
        },
      },
      {
        name: "rpc",
        external: {
          address: "127.0.0.1:9898",
          http: {},
        },
      },
    ],
  });
  console.log(result);
  yield* Effect.never;
});

NodeRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.provide(Runtime.RuntimeLive),
    Effect.provide(NodeServices.layer),
  ),
);
