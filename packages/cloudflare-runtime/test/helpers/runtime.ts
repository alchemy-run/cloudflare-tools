import * as NodeServices from "@effect/platform-node/NodeServices";
import type { Done } from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Globals from "../../src/globals/Globals.ts";
import * as Internet from "../../src/globals/Internet.ts";
import * as Storage from "../../src/globals/Storage.ts";
import * as Paths from "../../src/internal/Paths.ts";
import * as Registry from "../../src/registry/Registry.ts";
import * as RegistryProxy from "../../src/registry/RegistryProxy.ts";
import {
  resolvedTargetKey,
  type ResolvedTargetMap,
  type Subscriber,
} from "../../src/registry/RegistryTypes.shared.ts";
import * as Runtime from "../../src/Runtime.ts";
import * as RuntimeServices from "../../src/RuntimeServices.ts";
import type { BindingHooks, RuntimeWorker } from "../../src/RuntimeWorker.ts";
import * as Workerd from "../../src/workerd/Workerd.ts";

export const configProvider = (input: { fileSystemSupportsWatcher?: boolean } = {}) =>
  ConfigProvider.layer(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return ConfigProvider.fromUnknown({
        CLOUDFLARE_RUNTIME_HOME: yield* fs.makeTempDirectoryScoped({
          prefix: "cloudflare-runtime-test",
        }),
        CLOUDFLARE_RUNTIME_FILE_SYSTEM_SUPPORTS_WATCHER: input.fileSystemSupportsWatcher,
      });
    }),
  );

/**
 * A `Runtime` layer suitable for local-only tests.
 *
 * Excludes `RemoteBindings` so the tests don't require Cloudflare API
 * credentials. Workers configured here may use any local binding (Json,
 * Text, Data, KvNamespace local, Loopback, DurableObjectNamespace, etc.)
 * but **must not** register a remote binding — that would attempt to
 * deploy a preview script and fail without credentials.
 */
export const localRuntimeLayer = Runtime.RuntimeLive.pipe(
  Layer.provideMerge(RuntimeServices.layerLocalBindings()),
  Layer.provideMerge(RuntimeServices.layerProxy()),
  Layer.provide(Globals.GlobalsLive),
  Layer.provideMerge(RuntimeServices.layerLoopback()),
  Layer.provide(Storage.layerTemp()),
  Layer.provide(Internet.InternetLive),
  Layer.provideMerge(RegistryProxy.RegistryProxyLive),
  Layer.provideMerge(Registry.RegistryLive),
  Layer.provideMerge(Paths.PathsLive),
  Layer.provide(Workerd.WorkerdLive),
  Layer.provide(configProvider()),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
);

/**
 * Start a worker via the `Runtime` and return helpers bound to its base URL.
 *
 * The returned `fetch` accepts a path or full URL; relative paths are
 * resolved against the worker's base URL.
 */
export const startTestWorker = <B extends BindingHooks>(worker: RuntimeWorker<B>) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.Runtime;
    const baseUrl = yield* runtime.start(worker);
    const fetch = (path: string, init?: RequestInit) =>
      Effect.promise(() => globalThis.fetch(new URL(path, baseUrl), init));
    const fetchText = (path: string, init?: RequestInit) =>
      fetch(path, init).pipe(Effect.flatMap((res) => Effect.promise(() => res.text())));
    const fetchJson = <T>(path: string, init?: RequestInit) =>
      fetch(path, init).pipe(
        Effect.flatMap((res) => Effect.promise(() => res.json() as Promise<T>)),
      );
    return { baseUrl, fetch, fetchText, fetchJson };
  });

export const waitForRegistryEntry = Effect.fn(function* (
  subscriber: Subscriber,
  options: { toBeDefined: boolean } = { toBeDefined: true },
) {
  const registry = yield* Registry.Registry;
  const queue = yield* Queue.unbounded<ResolvedTargetMap, Done<void>>();
  yield* registry.subscribe([subscriber]).pipe(Stream.runIntoQueue(queue), Effect.forkScoped);
  while (true) {
    const value = yield* Queue.take(queue);
    const isDefined = resolvedTargetKey(subscriber) in value;
    if (isDefined === options.toBeDefined) {
      return;
    }
  }
}, Effect.scoped);
