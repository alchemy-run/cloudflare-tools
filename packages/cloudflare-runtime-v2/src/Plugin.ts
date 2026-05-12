import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { ConfigBuilder, type ConfigHook } from "./ConfigBuilder.ts";
import type { RuntimeWorker } from "./RuntimeWorker.ts";
import type * as WorkerdConfig from "./workerd/Config.ts";
import type { ControlMessage } from "./workerd/Workerd.ts";

export type AnyPlugin = Plugin<any>;

export interface Plugin<Api = never> {
  readonly defer?: boolean;
  readonly config?:
    | Configuration
    | ((worker: RuntimeWorker, api: Api) => Effect.Effect<Configuration>);
  readonly start?: (
    controlMessage: Array<ControlMessage>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly api: [Api] extends [never] ? undefined : Api;
}

export interface Configuration {
  services?: Array<WorkerdConfig.Service>;
  sockets?: Array<WorkerdConfig.Socket>;
  extensions?: Array<WorkerdConfig.Extension>;
  middlewares?: Array<Middleware>;
}

export interface Middleware {
  name: string;
  worker: WorkerdConfig.Worker;
  upstreamBindingName: string;
}
type PluginEffect<Api> = Effect.Effect<Plugin<Api>, never, ConfigBuilder>;
type ServiceClass<Self, Key extends string, Api> = Context.ServiceClass<
  Self,
  Key,
  PluginEffect<Api>
> & {
  Self: Self;
  Api: Api;
  Plugin: Plugin<Api>;
  of: (plugin: Plugin<Api>) => Plugin<Api>;
};
type AnyServiceClass = ServiceClass<any, any, any>;

export const Service =
  <Self, Api = never>() =>
  <Identifier extends `plugin:${string}`>(
    identifier: Identifier,
  ): ServiceClass<Self, Identifier, Api> =>
    Context.Service<Self, PluginEffect<Api>>()(identifier) as ServiceClass<Self, Identifier, Api>;

export const effect = <E, R, P extends AnyServiceClass>(
  plugin: P,
  effect: Effect.Effect<P["Plugin"], E, R>,
): Layer.Layer<P["Self"], E, R> =>
  Layer.effect(
    plugin,
    Effect.gen(function* () {
      const pluginInstance = yield* effect;
      return Effect.gen(function* () {
        const configBuilder = yield* ConfigBuilder;
        yield* configBuilder.register<any>(plugin.key, { ...pluginInstance });
        return pluginInstance;
      });
    }),
  );

export const sync = <P extends AnyServiceClass>(plugin: P, value: () => P["Plugin"]) =>
  effect(plugin, Effect.sync(value));

export const succeed = <P extends AnyServiceClass>(plugin: P, value: P["Plugin"]) =>
  effect(plugin, Effect.succeed(value));

export const use = <A, E, R, P extends AnyServiceClass>(
  plugin: P,
  use: (plugin: P["Plugin"]) => Effect.Effect<A, E, R>,
): ConfigHook<A, E, R | P["Self"]> =>
  Effect.gen(function* () {
    const configBuilder = yield* ConfigBuilder;
    const instance = yield* configBuilder.get<P["Plugin"]>(plugin.key);
    if (!instance) {
      return yield* Effect.die(new Error(`Plugin ${plugin.key} not found`));
    }
    return yield* use(instance);
  });

export const useSync = <A, P extends AnyServiceClass>(
  plugin: P,
  useSync: (plugin: P["Plugin"]) => A,
): ConfigHook<A, never, P["Self"]> => use(plugin, (instance) => Effect.succeed(useSync(instance)));
