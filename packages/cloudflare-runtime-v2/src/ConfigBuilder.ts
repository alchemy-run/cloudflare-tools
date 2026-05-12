import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Plugin from "./Plugin.ts";
import { moduleToWorkerd, type RuntimeWorker } from "./RuntimeWorker.ts";
import type * as WorkerdConfig from "./workerd/Config.ts";

export class ConfigBuilder extends Context.Service<
  ConfigBuilder,
  {
    readonly register: <P extends Plugin.Plugin<any>>(
      name: string,
      plugin: P,
    ) => Effect.Effect<void>;
    readonly get: <P extends Plugin.AnyPlugin>(name: string) => Effect.Effect<P | undefined>;
    readonly load: () => Effect.Effect<void>;
    readonly config: (worker: RuntimeWorker) => Effect.Effect<{
      entry: string | undefined;
      sockets: Array<WorkerdConfig.Socket>;
      services: Array<WorkerdConfig.Service>;
      extensions: Array<WorkerdConfig.Extension>;
    }>;
  }
>()("cloudflare-runtime/ConfigBuilder") {}

export type ConfigHook<A, E, R> = Effect.Effect<A, E, R | ConfigBuilder>;

const make = Effect.gen(function* () {
  const plugins = new Map<string, Plugin.AnyPlugin>();
  const resolve =
    (worker: RuntimeWorker, withDeferred: boolean) =>
    (plugin: Plugin.Plugin<any>): Effect.Effect<Plugin.Configuration> => {
      if (!plugin.config) return Effect.succeed({});
      if (withDeferred !== (plugin.defer ?? false)) return Effect.succeed({});
      if (typeof plugin.config === "function") return plugin.config(worker, plugin.api);
      return Effect.succeed(plugin.config);
    };
  const configBuilder = ConfigBuilder.of({
    get: Effect.fn(function* (name) {
      return plugins.get(name) as any;
    }),
    register: Effect.fn(function* (name: string, plugin) {
      plugins.set(name, plugin);
    }),
    load: Effect.fn(function* () {
      const context = yield* Effect.context();
      yield* Effect.forEach(context.mapUnsafe, ([key, pluginEffect]) =>
        Effect.gen(function* () {
          if (!key.startsWith("plugin:")) return;
          const plugin = yield* (
            pluginEffect as Effect.Effect<Plugin.AnyPlugin, never, ConfigBuilder>
          ).pipe(Effect.provideService(ConfigBuilder, configBuilder));
          plugins.set(key, plugin);
        }),
      );
    }),
    config: Effect.fn(function* (worker) {
      const configs = yield* Effect.zipWith(
        Effect.forEach(plugins.values(), resolve(worker, false), { concurrency: "unbounded" }),
        Effect.forEach(plugins.values(), resolve(worker, true), { concurrency: 1 }),
        (initialConfigs, deferredConfigs) => initialConfigs.concat(deferredConfigs),
      );
      const services = configs.flatMap((config) => config.services ?? []);
      const sockets = configs.flatMap((config) => config.sockets ?? []);
      const extensions = configs.flatMap((config) => config.extensions ?? []);
      const middlewares = configs.flatMap((config) => config.middlewares ?? []);
      return {
        entry: middlewares[0]?.name,
        sockets,
        extensions,
        services: [
          ...services,
          ...middlewares.map((middleware, index) => ({
            name: middleware.name,
            worker: {
              ...middleware.worker,
              bindings: [
                ...(middleware.worker.bindings ?? []),
                {
                  name: middleware.upstreamBindingName,
                  service: {
                    name: index < middlewares.length - 1 ? middlewares[index + 1].name : "user",
                  },
                },
              ],
            },
          })),
        ],
      };
    }),
  });
  return configBuilder;
});

export const build = Effect.fn(function* <E, R>(worker: RuntimeWorker<E, R>) {
  const configBuilder = yield* make;
  yield* configBuilder.load();
  const bindings = yield* Effect.all(worker.bindings, { concurrency: "unbounded" }).pipe(
    Effect.provideService(ConfigBuilder, configBuilder),
  );
  const modules = worker.modules.map(moduleToWorkerd);
  const { entry, sockets, services, extensions } = yield* configBuilder.config(
    worker as RuntimeWorker,
  );
  return {
    sockets: [
      {
        name: "http",
        address: "127.0.0.1:0",
        service: { name: entry ?? "user" },
      },
      ...sockets,
    ],
    services: [
      {
        name: "user",
        worker: {
          compatibilityDate: worker.compatibilityDate,
          compatibilityFlags: worker.compatibilityFlags,
          bindings,
          modules,
        },
      },
      ...services,
    ],
    extensions,
  };
});
