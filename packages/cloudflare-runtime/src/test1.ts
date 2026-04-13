import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { layers } from "./layers";
import { kVoid } from "./runtime/config.types";
import * as Runtime from "./runtime/runtime";
import { bundleAsEsModule } from "./utils/bundle";

const program = Effect.gen(function* () {
  const runtime = yield* Runtime.Runtime;
  const path = yield* Path.Path;
  yield* Effect.log("starting local");
  const local = yield* runtime.serve({
    sockets: [
      {
        name: "http",
        address: "127.0.0.1:1338",
        service: { name: "local-bridge" },
      },
      {
        name: "direct",
        address: "127.0.0.1:1339",
        service: { name: "user-worker" },
      },
    ],
    services: [
      {
        name: "user-worker",
        worker: {
          compatibilityDate: "2026-03-10",
          compatibilityFlags: ["enable_request_signal"],
          modules: [yield* bundleAsEsModule("src/workers/hello-world.worker.ts")],
        },
      },
      {
        name: "local-bridge",
        worker: {
          compatibilityDate: "2026-03-10",
          compatibilityFlags: ["experimental", "enable_request_signal"],
          modules: [yield* bundleAsEsModule("src/bridge/local.worker.ts")],
          bindings: [
            { name: "USER_WORKER", service: { name: "user-worker" } },
            { name: "BRIDGE", durableObjectNamespace: { className: "LocalBridge" } },
          ],
          durableObjectNamespaces: [
            { className: "LocalBridge", ephemeralLocal: kVoid, preventEviction: true },
          ],
        },
      },
      {
        name: "internet",
        network: {
          // Allow access to private/public addresses:
          // https://github.com/cloudflare/miniflare/issues/412
          allow: ["public", "private", "240.0.0.0/4"],
          deny: [],
          tlsOptions: {
            trustBrowserCas: true,
          },
        },
      },
    ],
  });
  yield* Effect.log("local server started");
  yield* Effect.log(local);
  yield* Effect.log("starting remote");
  const remote = yield* runtime.serve({
    sockets: [
      {
        name: "http",
        address: "127.0.0.1:1337",
        service: { name: "remote-bridge" },
      },
    ],
    services: [
      {
        name: "remote-bridge",
        worker: {
          compatibilityDate: "2026-03-10",
          modules: [yield* bundleAsEsModule("src/bridge/remote.worker.ts")],
          bindings: [{ name: "BRIDGE", durableObjectNamespace: { className: "RemoteBridge" } }],
          durableObjectNamespaces: [{ className: "RemoteBridge", uniqueKey: "remote-bridge" }],
          durableObjectStorage: {
            localDisk: "storage:disk",
          },
        },
      },
      {
        name: "storage:disk",
        disk: {
          path: path.resolve("out"),
          writable: true,
        },
      },
      {
        name: "internet",
        network: {
          // Allow access to private/public addresses:
          // https://github.com/cloudflare/miniflare/issues/412
          allow: ["public", "private", "240.0.0.0/4"],
          deny: [],
          tlsOptions: {
            trustBrowserCas: true,
          },
        },
      },
    ],
  });
  yield* Effect.log("remote server started");
  yield* Effect.log(remote);
  yield* Effect.log("done");
  yield* Effect.promise(async () => {
    const response = await fetch("http://localhost:1338/__configure", {
      method: "POST",
      body: JSON.stringify({ remote: "ws://localhost:1337/__connect" }),
    });
    console.log("[test1] configure response", {
      status: response.status,
      text: await response.text(),
    });
  });
  yield* Effect.never;
});

const controller = new AbortController();
process.on("SIGINT", () => {
  controller.abort();
});

await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(layers)), {
  signal: controller.signal,
});
