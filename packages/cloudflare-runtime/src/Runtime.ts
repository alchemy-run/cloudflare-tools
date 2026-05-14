import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { SOCKET_HTTP, USER_WORKER_SERVICE_NAME } from "./dev-registry/Constants.shared.ts";
import type * as Globals from "./globals/Globals.ts";
import * as Storage from "./globals/Storage.ts";
import type { BindingHook } from "./PluginContext.ts";
import * as PluginContext from "./PluginContext.ts";
import * as LocalProxy from "./proxy/LocalProxy.ts";
import type { RuntimeError } from "./RuntimeError.shared.ts";
import { moduleToWorkerd, type BindingHooks, type RuntimeWorker } from "./RuntimeWorker.ts";
import * as Workerd from "./workerd/Workerd.ts";

export class Runtime extends Context.Service<
  Runtime,
  {
    readonly start: <B extends BindingHooks>(
      worker: RuntimeWorker<B>,
    ) => Effect.Effect<string, RuntimeError, BindingRequirements<B> | Scope.Scope>;
  }
>()("cloudflare-runtime/Runtime") {}

type BindingRequirements<B extends BindingHooks> =
  B extends Array<never> ? never : B extends Array<BindingHook<infer R>> ? R : never;

export const RuntimeLive = Layer.effect(
  Runtime,
  Effect.gen(function* () {
    const workerd = yield* Workerd.Workerd;
    const storage = yield* Storage.Storage;
    const localProxy = yield* LocalProxy.LocalProxy;
    const plugins = yield* PluginContext.pickPluginsFromContext<Globals.Globals>();

    return Runtime.of({
      start: Effect.fn(function* (worker) {
        const context = yield* PluginContext.make(worker as RuntimeWorker, plugins);
        const bindings = yield* Effect.all(worker.bindings as ReadonlyArray<BindingHook<never>>, {
          concurrency: "unbounded",
        }).pipe(Effect.provideService(PluginContext.PluginContext, context));
        const { entry, sockets, services, extensions } = yield* context.config;
        const ports = yield* workerd.serve(
          {
            sockets: [
              {
                name: SOCKET_HTTP,
                address: "127.0.0.1:0",
                service: { name: entry ?? USER_WORKER_SERVICE_NAME },
              },
              ...sockets,
            ],
            services: [
              {
                name: USER_WORKER_SERVICE_NAME,
                worker: {
                  compatibilityDate: worker.compatibilityDate,
                  compatibilityFlags: worker.compatibilityFlags,
                  bindings,
                  modules: worker.modules.map(moduleToWorkerd),
                  durableObjectNamespaces: worker.durableObjectNamespaces?.map((namespace) => ({
                    className: namespace.className,
                    enableSql: namespace.sql,
                    uniqueKey: namespace.uniqueKey,
                    ephemeralLocal: namespace.ephemeralLocal,
                  })),
                  durableObjectStorage: {
                    localDisk: storage.name,
                  },
                },
              },
              ...services,
            ],
            extensions,
          },
          { "debug-port": "127.0.0.1:0" },
        );
        yield* context.start(ports);
        const address = `http://localhost:${ports.http}`;
        yield* localProxy.send({
          _tag: "Local.Set",
          worker: worker.name,
          address,
        });
        yield* Effect.addFinalizer(() =>
          localProxy
            .send({
              _tag: "Local.Unset",
              worker: worker.name,
              address,
            })
            .pipe(Effect.ignore),
        );
        return `${worker.name}.${localProxy.address}`;
      }),
    });
  }),
);
