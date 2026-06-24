export interface BasePluginOptions {
  /**
   * The main entry point to use.
   * Defaults to the one from your Rolldown configuration.
   * @default undefined
   */
  main?: string;
  /**
   * The compatibility date to use. This is optional, but should be defined to avoid unexpected behavior.
   * @default undefined
   */
  compatibilityDate?: string;
  /**
   * The compatibility flags to enable.
   * @default []
   * @example
   * ```ts
   * cloudflare({ compatibilityDate: "2026-04-01", compatibilityFlags: ["nodejs_compat"] });
   * ```
   */
  compatibilityFlags?: Array<string>;
  /**
   * The exports to include in the bundle.
   * By default, all exports are included. However, if you only want to include certain exports, you can use this option.
   * @example
   * ```ts
   * cloudflare({ exports: ["default"] });
   * ```
   */
  exports?: Array<string>;
  /**
   * Which Vite environment hosts the Worker, and any child environments it
   * loads at runtime. Defaults to the single `ssr` environment.
   *
   * `@vitejs/plugin-rsc` apps run the Worker in the `rsc` environment (resolved
   * with the `react-server` condition) and load the `ssr` environment from it,
   * so they set `{ name: "rsc", childEnvironments: ["ssr"] }`. Every named
   * environment is given the Worker treatment (workerd resolve conditions,
   * dependency pre-bundling) and a module runner in dev.
   *
   * @default { name: "ssr", childEnvironments: [] }
   */
  viteEnvironment?: {
    name?: string;
    childEnvironments?: Array<string>;
  };
}
