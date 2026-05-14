import * as Chokidar from "chokidar";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as XdgAppPaths from "xdg-app-paths";
import { exitHook } from "../internal/exit-hook.ts";
import type { WorkerDefinition, WorkerRegistry } from "./DevRegistryTypes.shared.ts";

export type { WorkerDefinition, WorkerRegistry } from "./DevRegistryTypes.shared.ts";

export interface ExternalServiceMap extends Map<
  string,
  {
    classNames: Set<string>;
    entrypoints: Set<string | undefined>;
  }
> {}

export class DevRegistry extends Context.Service<
  DevRegistry,
  {
    /** Whether the registry has a configured path and is therefore active. */
    readonly isEnabled: boolean;
    /** The on-disk path used to store registry entries, if any. */
    readonly registryPath: string | undefined;
    /** Read the current set of registered workers from disk. */
    readonly getRegistry: () => Effect.Effect<WorkerRegistry>;
    /**
     * Write {@link WorkerDefinition} files for the given workers and start
     * keeping their mtimes fresh so other processes know they're alive.
     * Cleanup is tied to the layer's scope and to the process exit hook.
     */
    readonly register: (workers: Record<string, WorkerDefinition>) => Effect.Effect<void>;
    /**
     * Begin watching the registry directory. The provided `onUpdate` callback
     * fires whenever a file belonging to one of `services` changes. Watching
     * stops when the layer's scope closes.
     */
    readonly watch: (
      services: ExternalServiceMap,
      onUpdate: (registry: WorkerRegistry) => void,
    ) => Effect.Effect<void>;
  }
>()("cloudflare-runtime/dev-registry/DevRegistry") {}

export interface DevRegistryConfig {
  /**
   * Filesystem directory used to store worker definition files. When omitted
   * the registry is disabled and all operations are no-ops.
   */
  readonly registryPath?: string | undefined;
}

const HEARTBEAT_INTERVAL = "30 seconds";
const STALE_AFTER_MS = 300_000;

export const DevRegistryLive = Layer.effect(
  DevRegistry,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const registryPath = yield* DevRegistryPath;
    const isEnabled = registryPath !== undefined && registryPath !== "";

    const registeredWorkers = new Set<string>();
    let externalServices: ExternalServiceMap = new Map();
    let watcher: Chokidar.FSWatcher | undefined;
    let onUpdate: ((registry: WorkerRegistry) => void) | undefined;
    let previousJSON = "{}";

    // Sync removal of our registered files. Used both by the scope finalizer
    // and the process exit hook so that even on SIGINT/SIGTERM we leave the
    // registry directory clean.
    const unregisterAllSync = () => {
      if (!registryPath) {
        return;
      }
      for (const name of registeredWorkers) {
        try {
          NodeFs.unlinkSync(path.join(registryPath, name));
        } catch {
          // ignore — file may already be gone or owned by another process
        }
      }
      registeredWorkers.clear();
    };

    const removeExitHook = exitHook(unregisterAllSync);

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        unregisterAllSync();
        removeExitHook();
        if (watcher) {
          const w = watcher;
          watcher = undefined;
          yield* Effect.tryPromise(() => w.close()).pipe(Effect.ignore);
        }
      }),
    );

    const refresh = () => {
      if (!onUpdate || !registryPath) {
        return;
      }
      const registry = readWorkerRegistrySync(registryPath);
      const json = JSON.stringify(registry);
      if (json === previousJSON) {
        return;
      }
      const previousRegistry = JSON.parse(previousJSON) as WorkerRegistry;
      previousJSON = json;
      for (const [service] of externalServices) {
        if (JSON.stringify(registry[service]) !== JSON.stringify(previousRegistry[service])) {
          onUpdate(registry);
          break;
        }
      }
    };

    const heartbeat = Effect.gen(function* () {
      if (!registryPath || registeredWorkers.size === 0) {
        return;
      }
      const now = new Date();
      for (const name of registeredWorkers) {
        const definitionPath = path.join(registryPath, name);
        const exists = yield* fs.exists(definitionPath).pipe(Effect.orElseSucceed(() => false));
        if (exists) {
          yield* fs.utimes(definitionPath, now, now).pipe(Effect.ignore);
        }
      }
    });

    if (isEnabled) {
      yield* heartbeat.pipe(
        Effect.schedule(Schedule.spaced(HEARTBEAT_INTERVAL)),
        Effect.forkScoped,
      );
    }

    return DevRegistry.of({
      isEnabled,
      registryPath,
      getRegistry: () =>
        Effect.sync(() => (registryPath ? readWorkerRegistrySync(registryPath) : {})),
      register: (workers) =>
        Effect.gen(function* () {
          if (!registryPath) {
            return;
          }
          yield* fs.makeDirectory(registryPath, { recursive: true }).pipe(Effect.ignore);
          for (const [name, definition] of Object.entries(workers)) {
            const definitionPath = path.join(registryPath, name);
            yield* fs
              .writeFileString(definitionPath, JSON.stringify(definition, null, 2))
              .pipe(Effect.ignore);
            registeredWorkers.add(name);
          }
          refresh();
        }),
      watch: (services, onUpdateFn) =>
        Effect.gen(function* () {
          if (!registryPath || services.size === 0) {
            return;
          }
          externalServices = new Map(services);
          onUpdate = onUpdateFn;
          yield* fs.makeDirectory(registryPath, { recursive: true }).pipe(Effect.ignore);
          if (!watcher) {
            watcher = Chokidar.watch(registryPath, {
              // On Windows, chokidar's default `fs.watch` backend frequently
              // drops or delays create events for files added shortly after
              // the watcher attaches — especially under CI virtualization.
              // Fall back to polling on Windows so cross-process worker
              // registrations are observed reliably. The registry directory
              // is small, so the cost is negligible.
              usePolling: process.platform === "win32",
              interval: 100,
            }).on("all", () => {
              refresh();
            });
          }
          // Seed previousJSON so the first update fires only on real change.
          previousJSON = JSON.stringify(readWorkerRegistrySync(registryPath));
        }),
    });
  }),
);

/**
 * Read the worker registry from the specified path.
 *
 * Skips stale workers that haven't sent a heartbeat in over 5 minutes,
 * and removes their files from disk.
 *
 * Synchronous because callers need to read the registry from inside a
 * chokidar watcher callback that itself runs synchronously.
 */
function readWorkerRegistrySync(registryPath: string): WorkerRegistry {
  const registry: WorkerRegistry = {};

  if (!NodeFs.existsSync(registryPath)) {
    return registry;
  }

  for (const workerName of NodeFs.readdirSync(registryPath)) {
    try {
      const definitionPath = NodePath.join(registryPath, workerName);
      const stats = NodeFs.statSync(definitionPath, { throwIfNoEntry: false });

      if (stats === undefined || stats.mtime.getTime() < Date.now() - STALE_AFTER_MS) {
        try {
          NodeFs.unlinkSync(definitionPath);
        } catch {}
        continue;
      }

      const file = NodeFs.readFileSync(definitionPath, { encoding: "utf8", flag: "r" });
      registry[workerName] = JSON.parse(file);
    } catch {
      // Generally indicates the worker was too old and was removed by a parallel process
    }
  }

  return registry;
}

/**
 * Get the default path for the dev registry.
 *
 * Honors `MINIFLARE_REGISTRY_PATH` so workers running across `wrangler dev`,
 * `vite dev`, and `cloudflare-runtime` all see each other.
 */
export const DevRegistryPath = Config.string("MINIFLARE_REGISTRY_PATH").pipe(
  Config.orElse(() => Config.succeed(NodePath.join(getGlobalWranglerConfigPath(), "registry"))),
);

function getGlobalWranglerConfigPath(): string {
  const configDir = XdgAppPaths.default(".wrangler").config();
  const legacyConfigDir = NodePath.join(NodeOs.homedir(), ".wrangler");
  if (NodeFs.statSync(legacyConfigDir, { throwIfNoEntry: false })?.isDirectory()) {
    return legacyConfigDir;
  }
  return configDir;
}
