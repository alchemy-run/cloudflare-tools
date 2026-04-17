import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import type { Binding } from "./bindings/index.ts";
import * as Bindings from "./bindings/index.ts";
import * as Bridge from "./bridge/bridge.ts";
import { Entry } from "./entry/entry.ts";
import type { Worker_Module } from "./runtime/config.types.ts";
import * as Runtime from "./runtime/runtime.ts";

export interface WorkerInput {
  name: string;
  accountId: string;
  compatibilityDate: string;
  compatibilityFlags?: Array<string>;
  bindings: Array<Binding>;
  modules: Array<Worker_Module>;
  durableObjectNamespaces?: Array<{ className: string; sql?: boolean; uniqueKey: string }>;
}

export type Server = Effect.Success<ReturnType<typeof make>>;

export const make = Effect.fn(function* (options: { port: number; storage: string }) {
  console.log("Making server", options);
  const runtime = yield* Runtime.Runtime;
  const services = yield* Bindings.RemoteBindingsServices;
  const bridge = yield* Bridge.Bridge;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const local = yield* bridge.local(options.port);
  const storageDir = path.resolve(options.storage);
  const scope = yield* Effect.scope;
  yield* fs.makeDirectory(storageDir, { recursive: true }).pipe(Effect.ignore);
  const map = new Map<string, Scope.Closeable>();
  const close = Effect.fn(function* (name: string) {
    const child = map.get(name);
    if (child) {
      yield* local.configure({ name, type: "local.unset" });
      yield* Scope.close(child, Exit.void);
      map.delete(name);
    }
  });
  return {
    address: `http://localhost:${options.port}`,
    serve: Effect.fn(function* (worker: WorkerInput) {
      yield* close(worker.name);
      const child = yield* Scope.fork(scope);
      map.set(worker.name, child);
      console.log("Updating server", worker);
      const { remoteBindings, workerBindings } = yield* Bindings.buildBindings(worker.bindings);
      const remoteBindingsServices = yield* services.services({
        accountId: worker.accountId,
        scriptName: worker.name,
        bindings: remoteBindings,
      });
      console.log("Remote bindings services", remoteBindingsServices);
      const server = yield* runtime
        .serve({
          sockets: [
            {
              name: "entry",
              address: "127.0.0.1:0",
              service: { name: "entry" },
            },
          ],
          services: [
            yield* Entry,
            {
              name: "user",
              worker: {
                compatibilityDate: worker.compatibilityDate,
                compatibilityFlags: worker.compatibilityFlags,
                modules: worker.modules,
                bindings: workerBindings,
                durableObjectNamespaces: worker.durableObjectNamespaces?.map((namespace) => ({
                  className: namespace.className,
                  enableSql: namespace.sql,
                  uniqueKey: namespace.uniqueKey,
                })),
                durableObjectStorage: {
                  localDisk: "storage",
                },
              },
            },
            {
              name: "storage",
              disk: {
                path: storageDir,
                writable: true,
                allowDotfiles: true,
              },
            },
            ...remoteBindingsServices,
          ],
        })
        .pipe(Scope.provide(child));
      console.log("Server", server);
      const address = `http://localhost:${server[0].port}`;
      yield* local.configure({ name: worker.name, type: "local.set", value: address });
      console.log("Updated server", address);
    }),
  };
});
