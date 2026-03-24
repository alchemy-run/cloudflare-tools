/**
 * Node.js Compatibility plugin (v2 only).
 *
 * Uses `unenv` + `@cloudflare/unenv-preset` to:
 * - Alias Node.js built-in imports to polyfills or the runtime
 * - Mark runtime-provided modules as external
 * - Inject global polyfills (process, console)
 *
 * @module
 */
import { getCloudflarePreset } from "@cloudflare/unenv-preset";
import { createRequire } from "node:module";
import { defineEnv } from "unenv";
import { createUnplugin } from "unplugin";

const require = createRequire(import.meta.url);

/**
 * Resolve a module specifier to an absolute file path,
 * from the context of this package (so we find unenv/preset deps).
 */
function resolveFrom(specifier: string): string {
  return require.resolve(specifier);
}

export interface NodejsCompatOptions {
  /** Compatibility date for the Workers runtime */
  readonly compatibilityDate?: string;
  /** Compatibility flags (e.g. ["nodejs_compat_v2"]) */
  readonly compatibilityFlags?: ReadonlyArray<string>;
}

/**
 * Resolved Node.js compatibility environment.
 *
 * Wraps the result of `defineEnv()` with `@cloudflare/unenv-preset`,
 * providing convenient access to aliases, externals, and injects.
 */
export class NodejsCompatEnv {
  /** Node.js modules that are handled by the Workers runtime (mark as external) */
  readonly externals: ReadonlySet<string>;
  /** Alias map: bare import → polyfill specifier */
  readonly alias: Readonly<Record<string, string>>;
  /** Globals to inject (e.g. process → "@cloudflare/unenv-preset/node/process") */
  readonly inject: Readonly<Record<string, string | ReadonlyArray<string>>>;
  /** Polyfill modules to import for side effects */
  readonly polyfill: ReadonlyArray<string>;

  constructor(options?: NodejsCompatOptions) {
    const { env } = defineEnv({
      presets: [
        getCloudflarePreset({
          compatibilityDate: options?.compatibilityDate,
          compatibilityFlags: options?.compatibilityFlags as Array<string> | undefined,
        }),
      ],
    });

    this.externals = new Set(env.external);
    this.alias = env.alias;
    this.inject = env.inject;
    this.polyfill = env.polyfill;
  }

  /**
   * Resolve a Node.js import to its polyfill or external status.
   *
   * Returns:
   * - `{ external: true }` if the module is handled by the runtime
   * - `{ resolved: string }` if the module has a polyfill alias
   * - `undefined` if not a Node.js module
   */
  resolveImport(source: string): { external: true } | { resolved: string } | undefined {
    // Check if it's external (handled by runtime)
    if (this.externals.has(source)) {
      return { external: true };
    }

    // Check if there's an alias
    const alias = this.alias[source];
    if (alias) {
      // If the alias is the same as the source (identity), it's handled by the runtime
      if (alias === source) {
        return { external: true };
      }
      // Resolve the alias to an absolute path
      try {
        const resolved = resolveFrom(alias);
        return { resolved };
      } catch {
        // If we can't resolve it, treat as external
        return { external: true };
      }
    }

    return undefined;
  }

  /**
   * Generate the code for a global injection virtual module.
   *
   * For example, for `process`:
   * ```js
   * import processExport from "@cloudflare/unenv-preset/node/process";
   * globalThis.process = processExport;
   * ```
   */
  generateGlobalInjectCode(): string {
    const lines: Array<string> = [];

    for (const [globalName, moduleSpecifier] of Object.entries(this.inject)) {
      if (typeof moduleSpecifier === "string") {
        const importName = `__inject_${globalName}`;
        lines.push(`import ${importName} from "${moduleSpecifier}";`);
        lines.push(`globalThis.${globalName} = ${importName};`);
      } else {
        const module = moduleSpecifier[0];
        const exportName = moduleSpecifier[1] ?? "default";
        const importName = `__inject_${globalName}`;
        lines.push(`import { ${exportName} as ${importName} } from "${module}";`);
        lines.push(`globalThis.${globalName} = ${importName};`);
      }
    }

    // Side-effect polyfill imports
    for (const polyfill of this.polyfill) {
      lines.push(`import "${polyfill}";`);
    }

    return lines.join("\n");
  }
}

const VIRTUAL_GLOBALS_ID = "\0cloudflare-bundler:nodejs-globals";

/**
 * Determine whether nodejs_compat_v2 is enabled based on compat flags.
 */
export function hasNodejsCompat(compatibilityFlags?: ReadonlyArray<string>): boolean {
  if (!compatibilityFlags) return false;
  return (
    compatibilityFlags.includes("nodejs_compat_v2") || compatibilityFlags.includes("nodejs_compat")
  );
}

/**
 * Create the Node.js compatibility plugin and environment.
 *
 * Returns the unplugin factory and the resolved environment for
 * use by the bundler layer (e.g. to configure esbuild's `inject`).
 */
export function createNodejsCompatPlugin(options?: NodejsCompatOptions) {
  const env = new NodejsCompatEnv(options);

  const plugin = createUnplugin((_options?: undefined) => ({
    name: "cloudflare-bundler:nodejs-compat",

    resolveId(id) {
      // Handle our virtual globals module
      if (id === VIRTUAL_GLOBALS_ID) {
        return { id: VIRTUAL_GLOBALS_ID, external: false };
      }

      const result = env.resolveImport(id);
      if (!result) return null;

      if ("external" in result) {
        return { id, external: true };
      }

      return result.resolved;
    },

    load(id) {
      if (id === VIRTUAL_GLOBALS_ID) {
        return env.generateGlobalInjectCode();
      }
      return null;
    },
  }));

  return {
    plugin,
    env,
    /** The virtual module ID that should be injected into the entry */
    virtualGlobalsId: VIRTUAL_GLOBALS_ID,
  };
}
