import * as queues from "@distilled.cloud/cloudflare/queues";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Bindings from "./bindings";
import { layers, run } from "./layers";
import * as Runtime from "./runtime/runtime";
import { bundle, bundleAsEsModule } from "./utils/bundle";

const deployBridge = Effect.gen(function* () {
  const accountId = yield* Config.string("CLOUDFLARE_ACCOUNT_ID");
  const createBetaWorker = yield* workers.createBetaWorker;
  const createBetaWorkerVersion = yield* workers.createBetaWorkerVersion;
  const createQueue = yield* queues.createQueue;
  const getQueue = yield* queues.getQueue;
  const listQueues = yield* queues.listQueues;
  const createConsumer = yield* queues.createConsumer;
  const queue = yield* createQueue({
    queueName: "my-john-queue",
    accountId,
  });
  console.log("queue deployed", queue);
  // console.log("queue deployed", queue);
  // const worker = yield* createBetaWorker({
  //   name: "remote-bindings",
  //   subdomain: { enabled: true },
  //   accountId,
  // });
  // console.log("worker deployed", worker);
  const files = yield* bundle("src/bridge/remote.worker.ts");
  const version = yield* createBetaWorkerVersion({
    workerId: "remote-bindings",
    accountId,
    compatibilityDate: "2026-03-10",
    mainModule: "worker.js",
    modules: [
      {
        name: "worker.js",
        contentBase64: Buffer.from(files[0].code).toString("base64"),
        contentType: "application/javascript+module",
      },
    ],
  });
  console.log("version deployed", version);
  const consumer = yield* createConsumer({
    queueId: queue.queueId!,
    accountId,
    scriptName: "remote-bindings",
    type: "worker",
  });
  console.log("consumer deployed", consumer);
});

const program = Effect.gen(function* () {
  const runtime = yield* Runtime.Runtime;
  const sessionProvider = yield* Bindings.SessionProvider;
  const accountId = yield* Config.string("CLOUDFLARE_ACCOUNT_ID");
  const { remoteBindings, workerBindings, additionalServices } = yield* Bindings.buildBindings([
    {
      name: "KV",
      type: "kv_namespace",
      namespaceId: "c2399b3754ea4199a765e8c388eb2603",
    },
    {
      name: "QUEUE",
      type: "queue",
      queueName: "my-john-queue",
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
      ...additionalServices,
    ],
  });
  yield* Effect.log(server);
  yield* Effect.never;
});

await run(deployBridge.pipe(Effect.scoped, Effect.provide(layers)));
