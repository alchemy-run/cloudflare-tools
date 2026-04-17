import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Bindings from "./bindings/index.ts";
import * as Bridge from "./bridge/bridge.ts";
import { Entry } from "./entry/entry.ts";
import * as Runtime from "./runtime/runtime.ts";

export const WorkerModule = Schema.Union([
  Schema.Struct({
    name: Schema.String,
    esModule: Schema.String,
  }),
  Schema.Struct({
    name: Schema.String,
    commonJsModule: Schema.String,
  }),
  Schema.Struct({
    name: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({
    name: Schema.String,
    data: Schema.Uint8Array,
  }),
  Schema.Struct({
    name: Schema.String,
    wasm: Schema.Uint8Array,
  }),
  Schema.Struct({
    name: Schema.String,
    json: Schema.String,
  }),
  Schema.Struct({
    name: Schema.String,
    pythonModule: Schema.String,
  }),
  Schema.Struct({
    name: Schema.String,
    pythonRequirement: Schema.String,
  }),
]);
export type WorkerModule = typeof WorkerModule.Type;

export const WorkerInput = Schema.Struct({
  name: Schema.String,
  accountId: Schema.String,
  compatibilityDate: Schema.String,
  compatibilityFlags: Schema.optional(Schema.Array(Schema.String)),
  bindings: Schema.Array(Bindings.Binding),
  modules: Schema.Array(WorkerModule),
  durableObjectNamespaces: Schema.optional(
    Schema.Array(
      Schema.Struct({
        className: Schema.String,
        sql: Schema.optional(Schema.Boolean),
        uniqueKey: Schema.String,
      }),
    ),
  ),
});
export type WorkerInput = typeof WorkerInput.Type;

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
                compatibilityFlags: worker.compatibilityFlags as Array<string>,
                modules: worker.modules as Array<WorkerModule>,
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
      return { name: worker.name, address };
    }),
    close,
  };
});
