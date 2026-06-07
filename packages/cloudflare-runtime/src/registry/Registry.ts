import { exitHook } from "@alchemy.run/node-utils/exit-hook";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as NodeFs from "node:fs";
import * as Paths from "../internal/Paths.ts";
import * as System from "../internal/System.ts";
import { SystemError } from "../RuntimeError.shared.ts";
import {
  registryServiceKey,
  type RegistryEntry,
  type ResolvedServiceMap,
  type SubscriberEntry,
} from "./RegistryTypes.shared.ts";

export class Registry extends Context.Service<
  Registry,
  {
    readonly read: (
      subscribers: ReadonlyArray<SubscriberEntry>,
    ) => Effect.Effect<ResolvedServiceMap>;
    readonly write: (entry: RegistryEntry) => Effect.Effect<void, SystemError, Scope.Scope>;
    readonly subscribe: (
      subscribers: ReadonlyArray<SubscriberEntry>,
    ) => Stream.Stream<ResolvedServiceMap, never, Scope.Scope>;
  }
>()("cloudflare-runtime/registry/Registry") {}

const STALE_AFTER_MS = 300_000;

export const RegistryLive = Layer.effect(
  Registry,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* Paths.state("alchemy", "registry");

    const writeEntry = (entry: RegistryEntry) => {
      const entryPath = path.join(directory, `${encodeURIComponent(entry.scriptName)}.json`);
      return fs.writeFileString(entryPath, JSON.stringify(entry, null, 2)).pipe(
        Effect.zip(
          SubscriptionRef.update(ref, (map) => MutableHashMap.set(map, entry.scriptName, entry)),
          { concurrent: true },
        ),
        Effect.tap(() => {
          const unregister = exitHook(() => NodeFs.unlinkSync(entryPath));
          return Effect.addFinalizer(() => {
            unregister();
            return fs.remove(entryPath).pipe(Effect.ignore);
          });
        }),
        Effect.tap(() =>
          DateTime.nowAsDate.pipe(
            Effect.flatMap((now) => fs.utimes(entryPath, now, now)),
            Effect.schedule(Schedule.spaced("30 seconds")),
            Effect.forkScoped,
          ),
        ),
      );
    };

    const ensureNonStale = (entryPath: string) =>
      Effect.zip(
        fs.stat(entryPath).pipe(Effect.map((stat) => Option.getOrUndefined(stat.mtime))),
        DateTime.nowAsDate,
        { concurrent: true },
      ).pipe(
        Effect.map(([mtime, now]) => !!mtime && mtime.getTime() > now.getTime() - STALE_AFTER_MS),
        Effect.tap((valid) => (valid ? Effect.void : fs.remove(entryPath).pipe(Effect.forkDetach))),
      );

    const readEntry = (entry: string) => {
      const entryPath = path.join(directory, entry);
      return Effect.zipWith(
        ensureNonStale(entryPath),
        fs
          .readFileString(entryPath)
          .pipe(Effect.map((content) => [entry, JSON.parse(content)] as const)),
        (valid, entryContent) => (valid ? entryContent : undefined),
        { concurrent: true },
      ).pipe(Effect.orElseSucceed(() => undefined));
    };

    const readAll = fs.readDirectory(directory).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(entries, readEntry, {
          concurrency: "unbounded",
        }),
      ),
      Effect.map((entries) =>
        MutableHashMap.make(...entries.filter((entry) => entry !== undefined)),
      ),
    );

    const ref = yield* SubscriptionRef.make(MutableHashMap.empty<string, RegistryEntry>());

    // The `fileSystemSupportsWatcher` flag is set to false on Windows and true everywhere else.
    // The flag can be overridden using a ConfigProvider, e.g. for testing.
    // If the watcher is not supported, we fall back to polling every 100ms.
    yield* (
      (yield* System.fileSystemSupportsWatcher)
        ? fs.watch(directory).pipe(Stream.mapEffect(() => readAll))
        : Stream.fromEffect(readAll).pipe(Stream.repeat(Schedule.spaced(100)))
    ).pipe(
      Stream.tap((newValue) => SubscriptionRef.set(ref, newValue)),
      Stream.runDrain,
      Effect.forkDetach,
    );

    const findMatch = (subscriber: SubscriberEntry, registry: RegistryEntry) => {
      switch (subscriber.kind) {
        case "worker":
          return registry.scriptName === subscriber.scriptName ? registry.services[0] : undefined;
        case "durable-object":
          return registry.scriptName === subscriber.scriptName
            ? registry.services.find(
                (service) =>
                  service.kind === "durable-object" && service.className === subscriber.className,
              )
            : undefined;
        case "queue-consumer":
          return registry.services.find(
            (service) =>
              service.kind === "queue-consumer" && service.queueName === subscriber.queueName,
          );
        case "workflow":
          return registry.scriptName === subscriber.scriptName
            ? registry.services.find(
                (service) =>
                  service.kind === "workflow" && service.workflowName === subscriber.workflowName,
              )
            : undefined;
      }
    };

    const pick =
      (subscribers: ReadonlyArray<SubscriberEntry>) =>
      (registry: MutableHashMap.MutableHashMap<string, RegistryEntry>) => {
        const resolved: ResolvedServiceMap = {};
        for (const entry of MutableHashMap.values(registry)) {
          for (const subscriber of subscribers) {
            const match = findMatch(subscriber, entry);
            if (match) {
              resolved[registryServiceKey(subscriber)] = {
                ...match,
                scriptName: entry.scriptName,
                debugPortAddress: entry.debugPortAddress,
              };
            }
          }
        }
        return resolved;
      };

    return Registry.of({
      read: (subscribers) => SubscriptionRef.get(ref).pipe(Effect.map(pick(subscribers))),
      write: (entry) =>
        writeEntry(entry).pipe(
          Effect.mapError(
            (error) =>
              new SystemError({
                subtag: "RegistryWriteError",
                message: "Failed to write registry entry",
                hint: "The registry entry could not be written to the filesystem.",
                detail: {
                  entry,
                },
                cause: error,
              }),
          ),
        ),
      subscribe: (subscribers) =>
        SubscriptionRef.changes(ref).pipe(Stream.map(pick(subscribers)), Stream.changes),
    });
  }),
);
