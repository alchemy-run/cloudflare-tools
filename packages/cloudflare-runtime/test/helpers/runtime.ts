import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as DevRegistry from "../../src/dev-registry/DevRegistry.ts";
import * as Globals from "../../src/globals/Globals.ts";
import * as Internet from "../../src/globals/Internet.ts";
import * as Storage from "../../src/globals/Storage.ts";
import * as Runtime from "../../src/Runtime.ts";
import * as RuntimeServices from "../../src/RuntimeServices.ts";
import type { BindingHooks, RuntimeWorker } from "../../src/RuntimeWorker.ts";
import * as Workerd from "../../src/workerd/Workerd.ts";

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
  Layer.provide(DevRegistry.DevRegistryLive),
  Layer.provide(Workerd.WorkerdLive),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
);

const temporaryRegistryLayer = (prefix: string) =>
  ConfigProvider.layer(
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix })),
      Effect.map((path) => ConfigProvider.fromUnknown({ MINIFLARE_REGISTRY_PATH: path })),
    ),
  );

export const localRuntimeWith = (options: { temporaryRegistryPrefix: string }) =>
  localRuntimeLayer.pipe(
    Layer.provide(temporaryRegistryLayer(options.temporaryRegistryPrefix)),
    Layer.provide(NodeServices.layer),
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
    return { baseUrl, fetch, fetchText };
  });
