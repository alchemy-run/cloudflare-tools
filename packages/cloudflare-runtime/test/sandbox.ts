import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { KvNamespace } from "../src/bindings/index.ts";
import * as Runtime from "../src/Runtime.ts";
import * as RuntimeServices from "../src/RuntimeServices.ts";

const main = Effect.gen(function* () {
  const runtime = yield* Runtime.Runtime;
  const address = yield* runtime.start({
    name: "test",
    compatibilityDate: "2026-01-01",
    compatibilityFlags: [],
    bindings: [KvNamespace.remote("TEST", "5fbeab5e45874f8a98daaf680fc2dd09")],
    modules: [
      {
        name: "test.js",
        type: "ESModule",
        content: `export default { fetch: async (request, env) => {
          const list = await env.TEST.list();
            return Response.json(list);
          } }`,
      },
    ],
    assets: {
      directory: "node_modules",
    },
  });
  console.log(address);
  const res = yield* Effect.promise(async () => {
    const res = await fetch(new URL("/", `http://${address}`));
    return {
      status: res.status,
      body: await res.text(),
    };
  });
  console.log(res);
  return res;
});

await main.pipe(
  Effect.provide(
    RuntimeServices.layerRuntime({
      server: { port: 0, host: "127.0.0.1" },
      api: { accountId: process.env.CLOUDFLARE_ACCOUNT_ID!, credentials: Credentials.fromEnv() },
    }),
  ),
  Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  Effect.scoped,
  Effect.runPromise,
);
