import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { Simplify } from "effect/Types";
import { PluginContext, type ConfigHook } from "./PluginContext.ts";
import type { RuntimeError } from "./RuntimeError.shared.ts";
import type * as WorkerdConfig from "./workerd/Config.ts";
import type * as Workerd from "./workerd/Workerd.ts";

export type Plugin<Api = never> = WithApi<
  PluginConfig & { readonly defer?: Effect.Effect<PluginConfig> },
  Api
>;

type WithApi<T, Api> = [Api] extends [never] ? Simplify<T> : Simplify<T & { readonly api: Api }>;

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
  | Plugin<Api>
  | Effect.Effect<Plugin<Api>, RuntimeError, PluginContext>;

export type PluginIdentifier<T extends string = string> = `cloudflare-runtime/plugin/${T}`;

export type PluginService<
  Self,
  Identifier extends PluginIdentifier,
  Api = never,
> = Context.ServiceClass<Self, Identifier, PluginBuilder<Api>>;

export const Service =
  <Self, Api = never>() =>
  <Identifier extends PluginIdentifier>(
    identifier: Identifier,
  ): Context.ServiceClass<Self, Identifier, PluginBuilder<Api>> =>
    Context.Service<Self, PluginBuilder<Api>>()(identifier);

export const use = <Self, Identifier extends PluginIdentifier, Api, A, E, R>(
  plugin: PluginService<Self, Identifier, Api>,
  f: (plugin: Plugin<Api>) => Effect.Effect<A, E, R>,
): ConfigHook<A, E, R | Self> =>
  PluginContext.use((context) => context.get(plugin).pipe(Effect.flatMap(f)));

export const useSync = <Self, Identifier extends PluginIdentifier, Api, A>(
  plugin: PluginService<Self, Identifier, Api>,
  f: (plugin: Plugin<Api>) => A,
): ConfigHook<A, never, Self> => use(plugin, (plugin) => Effect.succeed(f(plugin)));
