import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Bindings from "./bindings";
import { layers, run } from "./layers";
import * as Runtime from "./runtime/runtime";
import { bundleAsEsModule } from "./utils/bundle";

const program = Effect.gen(function* () {
  const runtime = yield* Runtime.Runtime;
  const sessionProvider = yield* Bindings.SessionProvider;
  const { remoteBindings, workerBindings } = yield* Bindings.buildBindings([
    {
      name: "KV",
      type: "kv_namespace",
      namespaceId: "c2399b3754ea4199a765e8c388eb2603",
    },
  ]);
  const options: Bindings.SessionOptions = {
    accountId: yield* Config.string("CLOUDFLARE_ACCOUNT_ID"),
    scriptName: "remote-bindings",
    bindings: remoteBindings,
  };
  const loopback = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        async fetch() {
          const config = await Effect.runPromise(sessionProvider.create(options));
          return Response.json(config);
        },
      }),
    ),
    (loopback) => Effect.promise(() => loopback.stop()),
  );
  const server = yield* runtime.serve({
    sockets: [
      {
        name: "http",
        address: "127.0.0.1:1337",
        service: { name: "user" },
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
      ...(yield* Bindings.Services(loopback.port!)),
    ],
  });
  yield* Effect.log(server);
  yield* Effect.never;
});

await run(program.pipe(Effect.scoped, Effect.provide(layers)));
