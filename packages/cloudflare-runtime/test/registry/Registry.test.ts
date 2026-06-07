import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { Done } from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Paths from "../../src/internal/Paths.ts";
import * as Registry from "../../src/registry/Registry.ts";
import {
  resolvedTargetKey,
  type RegistryEntry,
  type ResolvedTarget,
  type ResolvedTargetMap,
  type Subscriber,
} from "../../src/registry/RegistryTypes.shared.ts";
import { configProvider, waitForRegistryEntry } from "../helpers/runtime.ts";

describe.each([true, false])(
  "Registry (fileSystemSupportsWatcher: %s)",
  (fileSystemSupportsWatcher) => {
    const services = Registry.RegistryLive.pipe(
      Layer.provideMerge(Paths.PathsLive),
      Layer.provide(configProvider({ fileSystemSupportsWatcher })),
      Layer.provideMerge(NodeServices.layer),
    );

    const makeTestData = Effect.fn(function* (id: string) {
      const path = yield* Path.Path;
      const directory = yield* Paths.state("alchemy", "registry");
      const scriptName = `test-worker-${fileSystemSupportsWatcher ? "watcher" : "polling"}-${id}`;
      return {
        entryPath: path.join(directory, `${scriptName}.json`),
        registryEntry: registryEntry(scriptName),
        subscriberEntry: subscriberEntry(scriptName),
        registryServiceMap: registryServiceMap(scriptName),
      };
    });

    it.live("register writes a worker definition and read returns it", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const registry = yield* Registry.Registry;

        const { entryPath, subscriberEntry, registryEntry, registryServiceMap } =
          yield* makeTestData("1");

        const scope = yield* Scope.make();
        yield* registry.write(registryEntry).pipe(Scope.provide(scope));

        yield* waitForRegistryEntry(subscriberEntry, { toBeDefined: true });
        expect(yield* fs.exists(entryPath)).toBe(true);
        const mapNonEmpty = yield* registry.read([subscriberEntry]);
        expect(mapNonEmpty).toEqual(registryServiceMap);

        yield* Scope.close(scope, Exit.void);
        yield* waitForRegistryEntry(subscriberEntry, { toBeDefined: false });

        expect(yield* fs.exists(entryPath)).toBe(false);
        const mapEmpty = yield* registry.read([subscriberEntry]);
        expect(mapEmpty).toEqual({});
      }).pipe(Effect.provide(services)),
    );

    it.live("read returns an empty array when the directory is empty", () =>
      Effect.gen(function* () {
        const registry = yield* Registry.Registry;
        const { subscriberEntry } = yield* makeTestData("2");
        expect(yield* registry.read([subscriberEntry])).toEqual({});
      }).pipe(Effect.provide(services)),
    );

    it.live("read skips entries that don't match the subscriber", () =>
      Effect.gen(function* () {
        const registry = yield* Registry.Registry;
        const testData = yield* makeTestData("3a");
        yield* registry.write(testData.registryEntry);
        yield* waitForRegistryEntry(testData.subscriberEntry, { toBeDefined: true });
        expect(yield* registry.read([subscriberEntry("3b")])).toEqual({});
      }).pipe(Effect.provide(services)),
    );

    it.live("read skips definitions older than the staleness threshold", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const registry = yield* Registry.Registry;
        const { entryPath, subscriberEntry, registryServiceMap, registryEntry } =
          yield* makeTestData("4");

        yield* registry.write(registryEntry);
        yield* waitForRegistryEntry(subscriberEntry, { toBeDefined: true });

        expect(yield* registry.read([subscriberEntry])).toEqual(registryServiceMap);

        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
        yield* fs.utimes(entryPath, tenMinAgo, tenMinAgo);
        yield* waitForRegistryEntry(subscriberEntry, { toBeDefined: false });

        expect(yield* registry.read([subscriberEntry])).toEqual({});
      }).pipe(Effect.provide(services)),
    );

    it.live("subscribe fires when the registry changes", () =>
      Effect.gen(function* () {
        const registry = yield* Registry.Registry;
        const { registryEntry, subscriberEntry, registryServiceMap } = yield* makeTestData("5");
        const queue = yield* Queue.unbounded<ResolvedTargetMap, Done<void>>();
        yield* registry
          .subscribe([subscriberEntry])
          .pipe(Stream.runIntoQueue(queue), Effect.forkScoped);
        const first = yield* Queue.take(queue);
        expect(first).toEqual({});
        const scope = yield* Scope.make();
        yield* registry.write(registryEntry).pipe(Scope.provide(scope));
        const second = yield* Queue.take(queue);
        expect(second).toMatchObject(registryServiceMap);
        yield* Scope.close(scope, Exit.void);
        const third = yield* Queue.take(queue);
        expect(third).toEqual({});
      }).pipe(Effect.provide(services)),
    );
  },
);

const registryEntry = (scriptName: string): RegistryEntry => ({
  scriptName,
  debugPortAddress: "127.0.0.1:12345",
  services: [
    {
      kind: "worker",
      fetchService: "user",
      rpcService: "user",
    },
  ],
});

const subscriberEntry = (scriptName: string): Subscriber => ({ kind: "worker", scriptName });

const registryServiceMap = (scriptName: string): ResolvedTargetMap => {
  const service: ResolvedTarget<Subscriber.Worker> = {
    scriptName,
    debugPortAddress: "127.0.0.1:12345",
    kind: "worker",
    fetchService: "user",
    rpcService: "user",
  };
  return {
    [resolvedTargetKey(service)]: service,
  };
};
