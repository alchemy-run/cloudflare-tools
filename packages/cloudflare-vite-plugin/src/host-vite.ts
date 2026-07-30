import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as bundledVite from "vite";

export type ViteModule = typeof bundledVite;

const cache = new Map<string, Promise<ViteModule>>();

/**
 * Resolve the `vite` instance the host project is actually running.
 *
 * The plugin normally shares the host's copy of vite through its peer
 * dependency, but in monorepos (including this workspace, where fixtures pin
 * vite 7 while the plugin's dev dependency is vite 8) module resolution from
 * the plugin's own location can land on a different vite than the one that
 * created the dev server. Mixing instances breaks deep internals — a vite 8
 * `DevEnvironment` inside a vite 7 server crashes the dependency scanner
 * (`config.build.rolldownOptions` does not exist on a vite 7 resolved config)
 * and silently disables pre-bundling. Resolving from the project root keeps
 * the environment classes on the server's own vite; the bundled copy is only
 * a fallback when the root has no resolvable vite.
 */
export function resolveHostVite(root: string): Promise<ViteModule> {
  let result = cache.get(root);
  if (!result) {
    result = importHostVite(root);
    cache.set(root, result);
  }
  return result;
}

async function importHostVite(root: string): Promise<ViteModule> {
  try {
    const require = createRequire(path.resolve(root, "package.json"));
    // On Windows, absolute paths must be file:// URLs for ESM import().
    return (await import(pathToFileURL(require.resolve("vite")).href)) as ViteModule;
  } catch {
    return bundledVite;
  }
}
