import type * as rolldown from "rolldown";
import type * as vite from "vite";
import type { CloudflarePluginOptions } from "./options.js";

export interface PluginInput<A = any> {
  shared?: Omit<rolldown.Plugin<A>, "name">;
  rolldown?: Omit<rolldown.Plugin<A>, "name">;
  vite?: Omit<vite.Plugin<A>, "name">;
}

export interface NullablePluginOutput<A = any> {
  rolldown: (options: CloudflarePluginOptions) => rolldown.Plugin<A> | null;
  vite: (options: CloudflarePluginOptions) => vite.Plugin<A> | null;
}

export interface PluginOutput<A = any> {
  rolldown: (options: CloudflarePluginOptions) => rolldown.Plugin<A>;
  vite: (options: CloudflarePluginOptions) => vite.Plugin<A>;
}

export function createPlugin<TName extends string, A = any>(
  pluginName: TName,
  make: (options: CloudflarePluginOptions) => PluginInput<A>,
): PluginOutput<A>;

export function createPlugin<TName extends string, A = any>(
  pluginName: TName,
  make: (options: CloudflarePluginOptions) => PluginInput<A> | undefined,
): NullablePluginOutput<A>;

export function createPlugin<TName extends string, A = any>(
  pluginName: TName,
  make: (options: CloudflarePluginOptions) => PluginInput<A> | undefined,
): PluginOutput<A> | NullablePluginOutput<A> {
  const name = `distilled-cloudflare:${pluginName}`;
  return {
    rolldown: (options: CloudflarePluginOptions) => {
      const plugin = make(options);
      if (!plugin) return null;
      return {
        name,
        ...plugin.shared,
        ...plugin.rolldown,
      };
    },
    vite: (options: CloudflarePluginOptions) => {
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
