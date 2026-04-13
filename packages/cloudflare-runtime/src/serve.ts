import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Bindings from "./bindings";
import * as Bridge from "./bridge/bridge";
import { layers, run } from "./layers";
import * as Runtime from "./runtime/runtime";
import { bundleAsEsModule } from "./utils/bundle";

const program = Effect.gen(function* () {
  const bridge = yield* Bridge.Bridge;
  const runtime = yield* Runtime.Runtime;
  const sessionProvider = yield* Bindings.SessionProvider;
  const accountId = yield* Config.string("CLOUDFLARE_ACCOUNT_ID");
  const { remoteBindings, workerBindings, additionalServices } = yield* Bindings.buildBindings([
    {
      name: "KV",
      type: "kv_namespace",
      namespaceId: "c2399b3754ea4199a765e8c388eb2603",
    },
  ]);
  const options: Bindings.SessionOptions = {
    accountId,
    scriptName: "my-john-worker",
    bindings: remoteBindings,
  };
  const loopback = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        async fetch() {
          console.log("[serve] loopback fetch", options);
          const config = await Effect.runPromise(sessionProvider.create(options));
          console.log("[serve] loopback config", config);
          return Response.json(config);
        },
      }),
    ),
    (loopback) => Effect.promise(() => loopback.stop()),
  );
  const remoteBridgeUrl = yield* bridge.deploy("remote-bindings");
  const server = yield* runtime.serve({
    sockets: [
      {
        name: "http",
        address: "127.0.0.1:1337",
        service: { name: "user" },
      },
      {
        name: "bridge",
        address: "127.0.0.1:1338",
        service: { name: "bridge:local" },
      },
    ],
    services: [
      {
        name: "user",
        worker: {
          compatibilityDate: "2026-03-10",
          modules: [yield* bundleAsEsModule("src/workers/hello-world.worker.ts")],
          bindings: workerBindings,
        },
      },
      yield* bridge.local("user"),
      ...(yield* Bindings.Services(loopback.port!)),
      ...additionalServices,
    ],
  });
  yield* Effect.log({ server, remoteBridgeUrl });
  yield* bridge.configure("http://localhost:1338", remoteBridgeUrl);
  yield* Effect.never;
});

await run(program.pipe(Effect.scoped, Effect.provide(layers)));
