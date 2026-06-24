import type * as rolldown from "rolldown";
import type * as vite from "vite";
import type { BasePluginOptions } from "./options.js";

export interface PluginInput<A = any> {
  shared?: Omit<rolldown.Plugin<A>, "name">;
  rolldown?: Omit<rolldown.Plugin<A>, "name">;
  vite?: Omit<vite.Plugin<A>, "name">;
}

export interface NullablePluginOutput<A = any> {
  rolldown: (options: BasePluginOptions) => rolldown.Plugin<A> | null;
  vite: (options: BasePluginOptions) => vite.Plugin<A> | null;
}

export interface PluginOutput<A = any> {
  rolldown: (options: BasePluginOptions) => rolldown.Plugin<A>;
  vite: (options: BasePluginOptions) => vite.Plugin<A>;
}

export function createPlugin<TName extends string, A = any>(
  pluginName: TName,
  make: (options: BasePluginOptions) => PluginInput<A>,
): PluginOutput<A>;

export function createPlugin<TName extends string, A = any>(
  pluginName: TName,
  make: (options: BasePluginOptions) => PluginInput<A> | undefined,
): NullablePluginOutput<A>;

export function createPlugin<TName extends string, A = any>(
  pluginName: TName,
  make: (options: BasePluginOptions) => PluginInput<A> | undefined,
): PluginOutput<A> | NullablePluginOutput<A> {
  const name = `distilled-cloudflare:${pluginName}`;
  return {
    rolldown: (options: BasePluginOptions) => {
      const plugin = make(options);
      if (!plugin) return null;
      return {
        name,
        ...plugin.shared,
        ...plugin.rolldown,
      };
    },
    vite: (options: BasePluginOptions) => {
      const plugin = make(options);
      if (!plugin) return null;
      return {
        name,
        sharedDuringBuild: true,
        applyToEnvironment(environment) {
          return environment.name !== "client";
        },
        ...plugin.shared,
        ...plugin.vite,
      } as vite.Plugin;
    },
  };
}
