import * as Auth from "@distilled.cloud/cloudflare/Auth";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as NodeHttp from "node:http";
import { Assets, Hyperdrive, KvNamespace } from "./bindings/index.ts";
import * as Internet from "./Internet.ts";
import * as LocalProxy from "./proxy/LocalProxy.ts";
import * as RemoteBindings from "./remote-bindings/RemoteBindings.ts";
import * as Runtime from "./Runtime.ts";
import * as Storage from "./Storage.ts";
import * as Workerd from "./workerd/Workerd.ts";

const platform = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  NodeHttpServer.layerServer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 }),
);

export const layer = Runtime.RuntimeLive.pipe(
  Layer.provideMerge(Layer.mergeAll(Assets.AssetsLive, Hyperdrive.HyperdriveLive)),
  Layer.provideMerge(RemoteBindings.layerServices(process.env.CLOUDFLARE_ACCOUNT_ID!)),
  Layer.provide(LocalProxy.layerLive({ host: "localhost", port: 0 })),
  Layer.provide(Storage.layerTemp()),
  Layer.provide(Internet.InternetLive),
  Layer.provide(Workerd.WorkerdLive),
  Layer.provide(platform),
  Layer.provide(Auth.fromEnv()),
);

await Effect.gen(function* () {
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
}).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
