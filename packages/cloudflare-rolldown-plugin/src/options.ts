export interface CloudflarePluginOptions {
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
   * dependency pre-bundling) and a module runner in dev. Mirrors the
   * official `@cloudflare/vite-plugin` option of the same name.
   *
   * @default { name: "ssr", childEnvironments: [] }
   */
  viteEnvironment?: {
    name?: string;
    childEnvironments?: Array<string>;
  };
}

/**
 * Resolves the Worker's entry Vite environment and any child environments it
 * loads at runtime. The entry environment owns the Worker's input and build
 * output; children (e.g. an RSC app's `ssr` environment) still need the Worker
 * treatment and a dev module runner so the entry can load modules from them.
 */
export function workerEnvironments(options: CloudflarePluginOptions): {
  entry: string;
  children: Array<string>;
  all: Array<string>;
} {
  const entry = options.viteEnvironment?.name ?? "ssr";
  const children = options.viteEnvironment?.childEnvironments ?? [];

  // `client` is Vite's reserved browser environment — it must never be given
  // Worker config. Children must be distinct and must not collide with the
  // entry, since each environment name becomes a computed key in the generated
  // config (a collision would silently overwrite one env with another's
  // settings). Mirrors the validation in `@cloudflare/vite-plugin`.
  if (entry === "client") {
    throw new Error(
      `[cloudflare] viteEnvironment.name cannot be "client" (the reserved browser environment).`,
    );
  }
  for (const child of children) {
    if (child === "client") {
      throw new Error(
        `[cloudflare] viteEnvironment.childEnvironments cannot include "client" (the reserved browser environment).`,
      );
    }
    if (child === entry) {
      throw new Error(
        `[cloudflare] viteEnvironment.childEnvironments cannot include the entry environment "${entry}".`,
      );
    }
  }
  if (new Set(children).size !== children.length) {
    throw new Error(
      `[cloudflare] viteEnvironment.childEnvironments contains duplicate names: ${JSON.stringify(children)}`,
    );
  }

  return { entry, children, all: [entry, ...children] };
}
