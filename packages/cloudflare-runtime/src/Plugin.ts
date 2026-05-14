import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { PluginContext, type ConfigHook } from "./PluginContext.ts";
import type { ConfigError, RuntimeError } from "./RuntimeError.shared.ts";
import type * as WorkerdConfig from "./workerd/Config.ts";
import type * as Workerd from "./workerd/Workerd.ts";

export interface Plugin<Api = never> extends PluginConfig {
  readonly api: Api;
  readonly defer?: Effect.Effect<PluginConfig>;
}

export interface PluginConfig {
  readonly services?: Array<WorkerdConfig.Service>;
  readonly sockets?: Array<WorkerdConfig.Socket>;
  readonly extensions?: Array<WorkerdConfig.Extension>;
  readonly middlewares?: Array<Middleware>;
  readonly start?: (ports: Workerd.WorkerdPorts) => Effect.Effect<void, RuntimeError, Scope.Scope>;
}

export interface Middleware {
  name: string;
  worker: WorkerdConfig.Worker;
  upstreamBindingName: string;
}

export type PluginBuilder<Api = never> =
  | PluginResult<Api>
  | Effect.Effect<PluginResult<Api>, ConfigError, PluginContext>;

export type PluginResult<Api> = [Api] extends [never] ? Omit<Plugin<Api>, "api"> : Plugin<Api>;

export type PluginIdentifier<T extends string = string> = `cloudflare-runtime/plugin/${T}`;

export type PluginService<
  Self,
  Identifier extends PluginIdentifier,
  Api = never,
> = Context.ServiceClass<Self, Identifier, PluginBuilder<Api>> & {
  readonly Self: Self;
  readonly Plugin: Plugin<Api>;
};

export const Service =
  <Self, Api = never>() =>
  <Identifier extends PluginIdentifier>(
    identifier: Identifier,
  ): PluginService<Self, Identifier, Api> =>
    Context.Service<Self, PluginBuilder<Api>>()(identifier) as PluginService<Self, Identifier, Api>;

export const use = <S extends PluginService<any, any, any>, A, E, R>(
  plugin: S,
  f: (plugin: S["Plugin"]) => Effect.Effect<A, E, R>,
): ConfigHook<A, E, R | S["Self"]> =>
  PluginContext.use((context) => context.get(plugin).pipe(Effect.flatMap(f)));

export const useSync = <S extends PluginService<any, any, any>, A>(
  plugin: S,
  f: (plugin: S["Plugin"]) => A,
): ConfigHook<A, never, S["Self"]> => use(plugin, (plugin) => Effect.succeed(f(plugin)));
