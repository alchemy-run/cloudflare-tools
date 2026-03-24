/**
 * Cloudflare Externals plugin.
 *
 * Marks `cloudflare:*` built-in module imports as external so the bundler
 * doesn't try to resolve or bundle them. These modules are provided by the
 * Workers runtime.
 *
 * @module
 */
import { createUnplugin } from "unplugin";

/**
 * Known Cloudflare built-in modules.
 *
 * These are always available in the Workers runtime and must be
 * marked as external during bundling.
 */
export const CLOUDFLARE_BUILTINS = [
  "cloudflare:email",
  "cloudflare:node",
  "cloudflare:sockets",
  "cloudflare:workers",
  "cloudflare:workflows",
] as const;

export interface CloudflareExternalsOptions {
  /**
   * Additional `cloudflare:*` modules to treat as external,
   * beyond the known built-ins.
   */
  readonly additional?: ReadonlyArray<string>;
}

/**
 * unplugin that marks `cloudflare:*` imports as external.
 */
export const cloudflareExternals = createUnplugin((options?: CloudflareExternalsOptions) => {
  const extra = options?.additional ?? [];
  const known = new Set<string>([...CLOUDFLARE_BUILTINS, ...extra]);

  return {
    name: "cloudflare-bundler:externals",
    resolveId(id) {
      // Match any cloudflare: prefixed import
      if (id.startsWith("cloudflare:")) {
        if (!known.has(id)) {
          this.warn(
            `Unknown Cloudflare built-in module "${id}". ` +
              `Known modules: ${[...known].join(", ")}. ` +
              `Treating as external anyway.`,
          );
        }
        return { id, external: true };
      }
      return null;
    },
  };
});
