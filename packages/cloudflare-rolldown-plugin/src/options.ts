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

export const parseViteEnvironments = (options: BasePluginOptions): [string, ...Array<string>] => {
  const entry = options.viteEnvironment?.name ?? "ssr";
  if (entry === "client") {
    throw new Error(
      'The "client" environment cannot be used as a worker environment because it is reserved for the browser.',
    );
  }
  const children = (options.viteEnvironment?.childEnvironments ?? []).map((name, index, self) => {
    if (name === "client") {
      throw new Error(
        'The "client" environment cannot be used as a worker environment because it is reserved for the browser.',
      );
    } else if (self.indexOf(name) !== index) {
      throw new Error(
        `The name "${name}" appears more than once in the Vite environment list. Worker environment names must be unique.`,
      );
    } else if (name === entry) {
      throw new Error(
        `The child environment "${name}" cannot have the same name as the entry environment "${entry}".`,
      );
    }
    return name;
  });
  return [entry, ...children];
};
