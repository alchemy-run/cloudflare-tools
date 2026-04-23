import * as Auth from "@distilled.cloud/cloudflare/Auth";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Services from "../server/services.ts";
import * as DevServer from "./DevServer.ts";
import * as Lock from "./Lock.ts";
import * as Rpc from "./Rpc.ts";
import type { WsData } from "./RpcServer.ts";
import { newBunWebSocketRpcHandler } from "./RpcServer.ts";

const lockAcquireFirst = Layer.effect(
  Lock.Lock,
  Effect.gen(function* () {
    const lock = yield* Lock.make;
    yield* lock.acquire;
    return lock;
  }),
);

const layers = Layer.provideMerge(
  Layer.merge(Services.layer({ port: 1337, storage: ".cache/local" }), lockAcquireFirst),
  Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, Auth.fromEnv()),
);

const DevEntry = Effect.gen(function* () {
  const lock = yield* Lock.Lock;
  const server = yield* DevServer.DevServer;
  const fs = yield* FileSystem.FileSystem;
  const rpc = Rpc.server(server, DevServer.RpcSchema);

  const bun = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve<WsData>({
        port: 0,
        fetch: (request, server) => {
          if (server.upgrade(request, { data: undefined! })) {
            return;
          }
          return new Response("Not found", { status: 404 });
        },
        websocket: newBunWebSocketRpcHandler(() => rpc),
      }),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  );
  yield* fs.writeFileString(".cache/local/address.txt", `ws://${bun.hostname}:${bun.port}`);
  yield* Effect.addFinalizer(() => fs.remove(".cache/local/address.txt").pipe(Effect.ignore));

  yield* lock.monitor;
});

DevEntry.pipe(Effect.provide(layers), Effect.scoped, NodeRuntime.runMain);
