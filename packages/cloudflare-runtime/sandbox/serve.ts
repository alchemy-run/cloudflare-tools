import * as queues from "@distilled.cloud/cloudflare/queues";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Bindings from "../src/bindings";
import * as Bridge from "../src/bridge/bridge";
import { Entry } from "../src/entry/entry";
import * as Runtime from "../src/runtime/runtime";
import * as Bundle from "../src/utils/bundle";
import { layers, run } from "./layers";

const program = Effect.gen(function* () {
  const bridge = yield* Bridge.Bridge;
  const runtime = yield* Runtime.Runtime;
  const remoteBindingsServices = yield* Bindings.RemoteBindingsServices;
  const { remoteBindings, workerBindings } = yield* Bindings.buildBindings([
    {
      name: "KV",
      type: "kv_namespace",
      namespaceId: "c2399b3754ea4199a765e8c388eb2603",
    },
  ]);
  const options: Bindings.RemoteSessionOptions = {
    accountId: yield* Config.string("CLOUDFLARE_ACCOUNT_ID"),
    scriptName: "my-john-worker",
    bindings: remoteBindings,
  };
  const remoteBridgeUrl = yield* bridge.deploy("remote-bindings");
  const localBridge = yield* bridge.local(1337);
  const server = yield* runtime.serve({
    sockets: [
      {
        name: "bridge",
        address: "127.0.0.1:0",
        service: { name: "entry" },
      },
    ],
    services: [
      {
        name: "user",
        worker: {
          compatibilityDate: "2026-03-10",
          modules: yield* Bundle.bundle("src/workers/hello-world.worker.ts").pipe(
            Effect.flatMap(Bundle.bundleOutputToWorkerd),
          ),
          bindings: workerBindings,
        },
      },
      yield* Entry,
      ...(yield* remoteBindingsServices.services(options)),
    ],
  });
  const port = server[0].port;
  yield* localBridge.configure({ type: "local.set", value: `http://localhost:${port}` });
  yield* localBridge.configure({ type: "remote.set", value: remoteBridgeUrl });
  yield* Effect.log({ server, remoteBridgeUrl });
});

const testQueuePush = Effect.gen(function* () {
  const accountId = yield* Config.string("CLOUDFLARE_ACCOUNT_ID");
  const createQueue = yield* queues.createQueue;
  const createConsumer = yield* queues.createConsumer;
  const pushMessage = yield* queues.pushMessage;
  const deleteConsumer = yield* queues.deleteConsumer;
  const deleteQueue = yield* queues.deleteQueue;

  console.log("[testQueuePush] creating queue");
  const queue = yield* createQueue({
    accountId,
    queueName: "test-queue",
  });
  yield* Effect.addFinalizer(() => {
    console.log("[testQueuePush] deleting queue", queue.queueId);
    return deleteQueue({
      accountId,
      queueId: queue.queueId!,
    }).pipe(Effect.tapError(Effect.logWarning), Effect.ignore);
  });
  console.log("[testQueuePush] creating consumer for queue", queue.queueId);
  const consumer = yield* createConsumer({
    accountId,
    queueId: queue.queueId!,
    scriptName: "remote-bindings",
    type: "worker",
  });
  yield* Effect.addFinalizer(() => {
    console.log("[testQueuePush] deleting consumer", consumer.consumerId);
    return deleteConsumer({
      accountId,
      queueId: queue.queueId!,
      consumerId: consumer.consumerId!,
    }).pipe(Effect.tapError(Effect.logWarning), Effect.ignore);
  });
  console.log("[testQueuePush] pushing message to queue", queue.queueId);
  const message = yield* pushMessage({
    accountId,
    queueId: queue.queueId!,
    body: "Hello, world!",
    contentType: "text",
  }).pipe(Effect.tapError(Effect.logError));
  yield* Effect.log("[testQueuePush] pushMessage", message);
});

await run(
  Effect.all([program, testQueuePush, Effect.never]).pipe(Effect.scoped, Effect.provide(layers)),
);
