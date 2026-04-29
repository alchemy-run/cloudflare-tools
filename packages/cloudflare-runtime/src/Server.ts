import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Bindings from "./bindings/Bindings.ts";
import * as Entry from "./entry/Entry.ts";
import * as Plugin from "./Plugin.ts";
import * as LocalProxy from "./proxy/LocalProxy.ts";
import { ProxyError } from "./proxy/ProxyError.ts";
import * as Storage from "./Storage.ts";
import type { Worker } from "./Worker.ts";
import * as Runtime from "./workerd/Runtime.ts";
import { RuntimeError } from "./workerd/RuntimeError.ts";
import * as WorkerModule from "./WorkerModule.ts";

export interface ServeResult {
  readonly name: string;
  readonly address: string;
}

export const ServeError = Schema.Union([
  RuntimeError,
  ProxyError,
  Bindings.UnsupportedBindingError,
]);
export type ServeError = RuntimeError | ProxyError | Bindings.UnsupportedBindingError;

export class Server extends Context.Service<
  Server,
  {
    readonly serve: (worker: Worker) => Effect.Effect<ServeResult, ServeError, Scope.Scope>;
  }
>()("cloudflare-runtime/Server") {}

export const layer = Layer.effect(
  Server,
  Effect.gen(function* () {
    const runtime = yield* Runtime.Runtime;
    const localProxy = yield* LocalProxy.LocalProxy;
    const storage = yield* Storage.Storage;
    const bindingsService = yield* Bindings.Bindings;
    return Server.of({
      serve: Effect.fn(function* (worker) {
        const { entry, bindings, services, extensions } = yield* Plugin.build(worker, [
          Entry.EntryPlugin,
          bindingsService,
        ]);
        const result = yield* runtime.serve({
          sockets: [
            {
              name: "http",
              address: "127.0.0.1:0",
              service: { name: entry },
            },
          ],
          services: [
            {
              name: "user",
              worker: {
                compatibilityDate: worker.compatibilityDate,
                compatibilityFlags: worker.compatibilityFlags,
                modules: worker.modules.map(WorkerModule.toWorkerd),
                durableObjectNamespaces: worker.durableObjectNamespaces?.map((namespace) => ({
                  className: namespace.className,
                  enableSql: namespace.sql,
                  uniqueKey: namespace.uniqueKey,
                })),
                bindings,
                durableObjectStorage: {
                  localDisk: storage.name,
                },
              },
            },
            ...services,
            storage,
          ],
          extensions,
        });
        yield* localProxy.send({
          _tag: "Local.Set",
          worker: worker.name,
          address: `http://localhost:${result[0].port}`,
        });
        yield* Effect.addFinalizer(() =>
          localProxy
            .send({
              _tag: "Local.Unset",
              worker: worker.name,
            })
            .pipe(Effect.ignore),
        );
        return {
          name: worker.name,
          address: `http://${worker.name}.${localProxy.address}`,
        };
      }),
    });
  }),
);
