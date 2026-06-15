import * as fs from "node:fs";
import * as path from "node:path";
import type * as vite from "vite";
import type { CloudflarePluginOptions } from "../options.js";
import { workerEnvironments } from "../options.js";
import { WORKER_ENTRY_PREFIX } from "./virtual-modules.js";

/** Filename of the build manifest, written to the build output root. */
export const BUILD_MANIFEST_NAME = "__distilled-build.json";

/**
 * The deploy contract a production build emits. A deployer (e.g. Alchemy's
 * `Cloudflare.Vite`) reads this to learn the Worker's entry, its full module
 * set, and the static assets directory — rather than inferring them from
 * directory convention or a single environment's bundle.
 *
 * All paths are POSIX and relative to the manifest's own directory (the build
 * output root). The Worker's `modules` span the entry environment's output AND
 * every child environment it loads at runtime (e.g. an RSC app's `ssr` output,
 * pulled in via `import("../../ssr/index.js")`). Their relative layout is
 * preserved on disk, so those cross-environment imports resolve once the set is
 * uploaded as one Worker. Module kind is inferred from the file extension
 * (`.js`/`.mjs` → ES module, `.wasm` → compiled Wasm).
 */
export interface DistilledBuildManifest {
  version: 1;
  worker: {
    /** Entry module, relative to the manifest directory (e.g. `server/index.js`). */
    main: string;
    /** Every Worker module, relative to the manifest directory. */
    modules: Array<string>;
    compatibilityDate?: string;
    compatibilityFlags?: Array<string>;
  };
  /** Static assets, relative to the manifest directory. */
  assets?: {
    directory: string;
  };
}

const MODULE_EXTENSIONS = new Set([".js", ".mjs", ".wasm"]);

const toPosix = (p: string) => p.split(path.sep).join("/");

/** Recursively list the Worker module files under `dir`, relative to `root`. */
function listModules(dir: string, root: string): Array<string> {
  const modules: Array<string> = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (MODULE_EXTENSIONS.has(path.extname(entry.name))) {
        modules.push(toPosix(path.relative(root, full)));
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return modules;
}

/**
 * Emits the build manifest after a production build.
 *
 * Runs in the `buildApp` hook with `order: "post"` so it fires after the
 * framework plugin's build orchestration (e.g. `@vitejs/plugin-rsc`'s
 * multi-pass `buildApp`), once every environment has been written. Mirrors how
 * the official `@cloudflare/vite-plugin` writes its deploy config, but as a
 * wrangler-free manifest the deployer consumes directly.
 *
 * The Worker entry is the chunk built from the distilled worker-entry wrapper
 * (identified by its module marker). The module set is every JS/Wasm file
 * across the entry and child environment outputs; static assets are the
 * `client` output. Builds with no Worker entry (a pure SPA / assets-only site)
 * emit no manifest.
 */
export function buildManifestPlugin(options: CloudflarePluginOptions): vite.Plugin {
  const { entry, children } = workerEnvironments(options);
  const wantedEntryName = options.main ? path.parse(options.main).name : undefined;
  let mainFileName: string | undefined;

  return {
    name: "distilled-cloudflare:build-manifest",
    apply: "build",
    sharedDuringBuild: true,
    // Capture the entry chunk on a real write only — `writeBundle` doesn't fire
    // for the framework's non-writing scan passes (`build.write === false`), so
    // the filename always reflects the final emitted Worker.
    writeBundle(_outputOptions, bundle) {
      if (this.environment.name !== entry) return;
      const entryChunks = Object.values(bundle).filter(
        (chunk): chunk is vite.Rollup.OutputChunk => chunk.type === "chunk" && chunk.isEntry,
      );
      // Only the distilled worker-entry wrapper carries the marker; a
      // framework's own entry (e.g. plugin-rsc's `index`) does not. Fall back
      // to the configured `main`'s name, then the sole entry chunk.
      const byMarker = entryChunks.find((chunk) =>
        chunk.facadeModuleId?.startsWith(WORKER_ENTRY_PREFIX),
      );
      const byName = wantedEntryName
        ? entryChunks.find((chunk) => chunk.name === wantedEntryName)
        : undefined;
      const picked = byMarker ?? byName ?? entryChunks[0];
      if (picked) mainFileName = picked.fileName;
    },
    buildApp: {
      order: "post",
      async handler(builder) {
        // No Worker entry was emitted — a pure SPA / assets-only build has no
        // Worker to describe, so there's nothing to write.
        if (!mainFileName) return;

        const resolveOutDir = (name: string): string | undefined => {
          const environment = builder.environments[name];
          return environment
            ? path.resolve(builder.config.root, environment.config.build.outDir)
            : undefined;
        };

        const entryOutDir = resolveOutDir(entry);
        if (!entryOutDir) return;

        // The manifest sits at the build output root — the parent of the entry
        // environment's output. The distilled plugin places the entry, every
        // child, and the client output directly under this root (see
        // `getOutputDirectory`), so module paths resolve relative to it and the
        // framework's cross-environment imports stay intact.
        const manifestDir = path.dirname(entryOutDir);

        const modules = [entry, ...children]
          .map(resolveOutDir)
          .filter((dir): dir is string => dir !== undefined)
          .flatMap((dir) => listModules(dir, manifestDir));

        // Every Worker output must live under the manifest root. A module that
        // escapes it means the entry and child environments were written to
        // different roots — which the framework's baked cross-environment
        // imports can't satisfy either. That happens with a custom
        // `build.outDir` under the child-environment (RSC) topology; the result
        // isn't deployable, so emit nothing rather than a broken manifest.
        const escaping = modules.filter((module) => module.startsWith("../"));
        if (escaping.length > 0) {
          builder.config.logger.warn(
            `[cloudflare] skipping ${BUILD_MANIFEST_NAME}: ${escaping.length} worker module(s) ` +
              `resolve outside the build root. A custom build.outDir is not supported with the ` +
              `child-environment (RSC) topology.`,
          );
          return;
        }

        const clientOutDir = resolveOutDir("client");

        const manifest: DistilledBuildManifest = {
          version: 1,
          worker: {
            main: toPosix(path.relative(manifestDir, path.join(entryOutDir, mainFileName))),
            modules,
            compatibilityDate: options.compatibilityDate,
            compatibilityFlags: options.compatibilityFlags,
          },
          assets: clientOutDir
            ? { directory: toPosix(path.relative(manifestDir, clientOutDir)) }
            : undefined,
        };

        fs.writeFileSync(
          path.join(manifestDir, BUILD_MANIFEST_NAME),
          `${JSON.stringify(manifest, null, 2)}\n`,
        );
      },
    },
  };
}
