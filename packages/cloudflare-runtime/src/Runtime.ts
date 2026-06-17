import { exitHook } from "@alchemy.run/node-utils/exit-hook";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Docker from "./Docker.ts";
import type * as Globals from "./globals/Globals.ts";
import * as Storage from "./globals/Storage.ts";
import {
  defaultDurableObjectUniqueKey,
  SERVICE_USER_WORKER,
  SOCKET_USER_ENTRY,
} from "./internal/constants.ts";
import { moduleToWorkerd } from "./internal/internal-modules.ts";
import type { BindingHook } from "./PluginContext.ts";
import * as PluginContext from "./PluginContext.ts";
import type { RuntimeError } from "./RuntimeError.shared.ts";
import type { BindingHooks, RuntimeWorker } from "./RuntimeWorker.ts";
import * as Workerd from "./workerd/Workerd.ts";

export class Runtime extends Context.Service<
  Runtime,
  {
    readonly start: <B extends BindingHooks>(
      worker: RuntimeWorker<B>,
    ) => Effect.Effect<URL, RuntimeError, BindingRequirements<B> | Scope.Scope>;
  }
>()("cloudflare-runtime/Runtime") {}

type BindingRequirements<B extends BindingHooks> =
  B extends Array<never> ? never : B extends Array<BindingHook<infer R>> ? R : never;

export const RuntimeLive = Layer.effect(
  Runtime,
  Effect.gen(function* () {
    const workerd = yield* Workerd.Workerd;
    const storage = yield* Storage.Storage;
    const docker = yield* Docker.Docker;
    const plugins = yield* PluginContext.pickPluginsFromContext<Globals.Globals>();

    const preparePlugins = Effect.fnUntraced(function* (worker: RuntimeWorker) {
      const context = yield* PluginContext.make(worker as RuntimeWorker, plugins);
      const bindings = yield* Effect.all(worker.bindings as ReadonlyArray<BindingHook<never>>, {
        concurrency: "unbounded",
      }).pipe(Effect.provideService(PluginContext.PluginContext, context));
      return { config: yield* context.config, context, bindings };
    });

    const prepareContainers = Effect.fnUntraced(function* (worker: RuntimeWorker) {
      const containers = (worker.durableObjectNamespaces ?? []).flatMap((namespace) => {
        if (!namespace.container) return [];
        return { className: namespace.className, container: namespace.container };
      });
      if (!containers.length) {
        return { imageNames: new Map() };
      }
      const imageNames = new Map<string, string>();
      const [, containerEngine] = yield* Effect.forEach(
        containers,
        ({ className, container }) => {
          if ("tag" in container) {
            imageNames.set(className, container.tag);
            return docker.validate(container.tag);
          }
          const tag = docker.generateImageTag(className);
          imageNames.set(className, tag);
          const prepare =
            "imageUri" in container ? docker.pull(tag, container) : docker.build(tag, container);
          return prepare.pipe(
            Effect.andThen(docker.validate(tag)),
            Effect.tap(() => {
              const unregister = exitHook(() => docker.removeContainerSync(tag));
              return Effect.addFinalizer(() =>
                docker
                  .removeContainer(tag)
                  .pipe(Effect.andThen(Effect.sync(() => unregister())), Effect.ignore),
              );
            }),
            Effect.tap(() => Effect.forkDetach(docker.removeStaleImageTags(tag))),
          );
        },
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.zip(docker.getWorkerdDockerConfiguration, { concurrent: true }));
      return { imageNames, containerEngine };
    });

    return Runtime.of({
      start: Effect.fn(function* (worker) {
        const [{ config, context, bindings }, { containerEngine, imageNames }] = yield* Effect.all(
          [preparePlugins(worker), prepareContainers(worker)],
          { concurrency: "unbounded" },
        );
        const ports = yield* workerd.serve(
          {
            sockets: [
              {
                name: SOCKET_USER_ENTRY,
                address: "127.0.0.1:0",
                service: { name: config.entry ?? SERVICE_USER_WORKER },
              },
              ...config.sockets,
            ],
            services: [
              {
                name: SERVICE_USER_WORKER,
                worker: {
                  compatibilityDate: worker.compatibilityDate,
                  compatibilityFlags: worker.compatibilityFlags,
                  bindings,
                  modules: worker.modules.map(moduleToWorkerd),
                  durableObjectNamespaces: worker.durableObjectNamespaces?.map((namespace) => {
                    const imageName = imageNames.get(namespace.className);
                    return {
                      className: namespace.className,
                      enableSql: namespace.sql,
                      uniqueKey:
                        namespace.uniqueKey ??
                        defaultDurableObjectUniqueKey(worker.name, namespace.className),
                      ephemeralLocal: namespace.ephemeralLocal,
                      container: imageName ? { imageName } : undefined,
                    };
                  }),
                  durableObjectStorage: {
                    localDisk: storage.name,
                  },
                  containerEngine,
                },
              },
              ...config.services,
            ],
            extensions: config.extensions,
          },
          { "debug-port": "127.0.0.1:0" },
        );
        yield* context.start(ports);
        return new URL(`http://127.0.0.1:${ports[SOCKET_USER_ENTRY]}`);
      }),
    });
  }),
);
