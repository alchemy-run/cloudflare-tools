import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Server from "../src/server.ts";
import * as Bundle from "../src/utils/bundle.ts";
import { layers, run } from "./layers.ts";

const program = Effect.gen(function* () {
  const server = yield* Server.make({ port: 1337, storage: ".cache/local" });
  yield* server.serve({
    name: "main",
    accountId: yield* Config.string("CLOUDFLARE_ACCOUNT_ID"),
    compatibilityDate: "2026-03-10",
    bindings: [
      {
        name: "KV",
        type: "kv_namespace",
        namespaceId: "c2399b3754ea4199a765e8c388eb2603",
      },
    ],
    modules: yield* Bundle.bundle("sandbox/hello-world.worker.ts").pipe(
      Effect.flatMap(Bundle.bundleOutputToWorkerd),
    ),
  });
  yield* Effect.sleep(1000);
  yield* server.serve({
    name: "main",
    accountId: yield* Config.string("CLOUDFLARE_ACCOUNT_ID"),
    compatibilityDate: "2026-03-10",
    bindings: [
      {
        name: "KV",
        type: "kv_namespace",
        namespaceId: "c2399b3754ea4199a765e8c388eb2603",
      },
    ],
    modules: yield* Bundle.bundle("sandbox/hello-world-1.worker.ts").pipe(
      Effect.flatMap(Bundle.bundleOutputToWorkerd),
    ),
  });
  // const bridge = yield* Bridge.Bridge;
  // const runtime = yield* Runtime.Runtime;
  // const remoteBindingsServices = yield* Bindings.RemoteBindingsServices;
  // const { remoteBindings, workerBindings } = yield* Bindings.buildBindings([
  //   {
  //     name: "KV",
  //     type: "kv_namespace",
  //     namespaceId: "c2399b3754ea4199a765e8c388eb2603",
  //   },
  // ]);
  // const options: Bindings.RemoteSessionOptions = {
  //   accountId: yield* Config.string("CLOUDFLARE_ACCOUNT_ID"),
  //   scriptName: "my-john-worker",
  //   bindings: remoteBindings,
  // };
  // const remoteBridgeUrl = yield* bridge.deploy("remote-bindings");
  // const localBridge = yield* bridge.local(1337);
  // const server = yield* runtime.serve({
  //   sockets: [
  //     {
  //       name: "bridge",
  //       address: "127.0.0.1:0",
  //       service: { name: "entry" },
  //     },
  //   ],
  //   services: [
  //     {
  //       name: "user",
  //       worker: {
  //         compatibilityDate: "2026-03-10",
  // modules: yield* Bundle.bundle("sandbox/hello-world.worker.ts").pipe(
  //   Effect.flatMap(Bundle.bundleOutputToWorkerd),
  // ),
  //         bindings: workerBindings,
  //       },
  //     },
  //     yield* Entry,
  //     ...(yield* remoteBindingsServices.services(options)),
  //   ],
  // });
  // const port = server[0].port;
  // yield* localBridge.configure({ type: "local.set", value: `http://localhost:${port}` });
  // yield* localBridge.configure({ type: "remote.set", value: remoteBridgeUrl });
  // yield* Effect.log({ server, remoteBridgeUrl });
});

await run(Effect.all([program, Effect.never]).pipe(Effect.scoped, Effect.provide(layers)));
