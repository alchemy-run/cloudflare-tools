import * as fs from "node:fs";
import * as path from "node:path";
import type * as vite from "vite";
import type { CloudflarePluginOptions } from "../options.js";
import { workerEnvironments } from "../options.js";
import { MODULE_RULES } from "./additional-modules.js";
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
 * uploaded as one Worker. Module kind is explicit: `.js`/`.mjs` are ES modules,
 * `.json` files are JSON modules, and the {@link MODULE_RULES} extensions map
 * to their Cloudflare module type (`.wasm` → Wasm, `.bin` → Data,
 * `.txt`/`.html`/`.sql` → Text). Source maps are auxiliary debug artifacts, not
 * Worker modules, and are not listed here.
 *
 * The manifest describes only the *build* output. Deploy-time inputs the build
 * doesn't own — bindings, secrets, Durable Object classes and migrations,
 * source-map upload policy — are the deployer's responsibility.
 * `compatibilityDate` and `compatibilityFlags` record what the Worker was
 * *compiled* against and are authoritative: a deployer must deploy against the
 * same values. If `compatibilityDate` is absent, that absence is authoritative
 * too; deployers should fail or require an explicit deploy-time value rather
 * than silently substituting a default that may not match the build.
 */
export interface DistilledBuildManifest {
  version: 2;
  workers: {
    app: {
      /** Entry module, relative to the manifest directory (e.g. `server/index.js`). */
      main: string;
      /** Every Worker module, relative to the manifest directory. */
      modules: Array<DistilledWorkerModule>;
      compatibilityDate?: string;
      compatibilityFlags?: Array<string>;
    };
  };
  /** Static assets, relative to the manifest directory. */
  assets?: {
    directory: string;
    htmlHandling?: DistilledAssetHtmlHandling;
    notFoundHandling?: DistilledAssetNotFoundHandling;
    runWorkerFirst?: Array<string> | boolean;
  };
}

export type DistilledWorkerModuleType = "esm" | "wasm" | "data" | "text" | "json";
export type DistilledAssetHtmlHandling =
  | "auto-trailing-slash"
  | "force-trailing-slash"
  | "drop-trailing-slash"
  | "none";
export type DistilledAssetNotFoundHandling = "none" | "404-page" | "single-page-application";

export interface DistilledWorkerModule {
  path: string;
  type: DistilledWorkerModuleType;
}

interface BuildManifestPluginOptions extends CloudflarePluginOptions {
  assets?: {
    htmlHandling?: DistilledAssetHtmlHandling;
    notFoundHandling?: DistilledAssetNotFoundHandling;
    runWorkerFirst?: Array<string> | boolean;
  };
}

const toPosix = (p: string) => p.split(path.sep).join("/");

/**
 * A file is a Worker module if it's an ES module (`.js`/`.mjs`) or matches one
 * of the Cloudflare additional-module rules — the same rules the build uses to
 * *emit* those modules, so the two never drift.
 */
function getWorkerModuleType(name: string): DistilledWorkerModuleType | undefined {
  if (name.endsWith(".js") || name.endsWith(".mjs")) {
    return "esm";
  }
  if (name.endsWith(".json")) {
    return "json";
  }
  return MODULE_RULES.find((rule) => rule.pattern.test(name))?.manifestType;
}

/** Recursively list the Worker module files under `dir`, relative to `root`. */
function listModules(dir: string, root: string): Array<DistilledWorkerModule> {
  const modules: Array<DistilledWorkerModule> = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const relativePath = toPosix(path.relative(root, full));
        const type = getWorkerModuleType(entry.name);
        if (
          type &&
          relativePath !== ".vite/manifest.json" &&
          !relativePath.endsWith("/.vite/manifest.json")
        ) {
          modules.push({ path: relativePath, type });
        }
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return modules;
}

function getManifestDir(entryOutDir: string | undefined, clientOutDir: string | undefined) {
  const outputRoot = entryOutDir ?? clientOutDir;
  return outputRoot ? path.dirname(outputRoot) : undefined;
}

/**
 * Emits the build manifest after a production build.
 *
 * The Worker module set is read from disk (the on-disk tree includes files the
 * framework writes outside the rollup bundle, e.g. plugin-rsc's assets manifest
 * and encryption key). To keep that read exact, the Worker environment output
 * directories are emptied up front in `configResolved` — Vite's own
 * `emptyOutDir` is skipped for these environments because the framework's
 * non-writing scan passes mark them "rendered" first, which would otherwise let
 * stale files from previous builds leak into the manifest.
 *
 * The manifest is written in the `buildApp` hook with `order: "post"`, after
 * every environment (including the framework's multi-pass orchestration) has
 * been written. The Worker entry is the chunk built from the distilled
 * worker-entry wrapper (identified by its module marker, captured on the real
 * write). A build with no Worker entry (a pure SPA / assets-only site) emits no
 * manifest, and any stale manifest from a previous build is removed.
 */
export function buildManifestPlugin(options: BuildManifestPluginOptions): vite.Plugin {
  const { entry, children } = workerEnvironments(options);
  const workerEnvNames = [entry, ...children];
  const wantedEntryName = options.main ? path.parse(options.main).name : undefined;
  let mainFileName: string | undefined;

  return {
    name: "distilled-cloudflare:build-manifest",
    apply: "build",
    sharedDuringBuild: true,
    // Empty each Worker environment's output directory before the build writes,
    // so the on-disk module walk reflects only this build's output.
    configResolved(config) {
      const resolveOutDir = (name: string): string | undefined => {
        const outDir = config.environments[name]?.build.outDir;
        return outDir ? path.resolve(config.root, outDir) : undefined;
      };
      const manifestDir = getManifestDir(resolveOutDir(entry), resolveOutDir("client"));
      if (manifestDir) {
        // A plain Vite SPA build does not run the app builder hooks, so remove
        // any stale manifest before the build starts. Builds with a Worker will
        // write a fresh manifest later in buildApp.
        fs.rmSync(path.join(manifestDir, BUILD_MANIFEST_NAME), { force: true });
      }
      for (const name of workerEnvNames) {
        const outDir = resolveOutDir(name);
        if (outDir) {
          fs.rmSync(outDir, { recursive: true, force: true });
        }
      }
    },
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
        const resolveOutDir = (name: string): string | undefined => {
          const environment = builder.environments[name];
          return environment
            ? path.resolve(builder.config.root, environment.config.build.outDir)
            : undefined;
        };

        const entryOutDir = resolveOutDir(entry);
        const clientOutDir = resolveOutDir("client");

        // The manifest sits at the build output root — the parent of the entry
        // output, or, for an assets-only build with no worker environment, the
        // client output. The distilled plugin places the entry, every child, and
        // the client output directly under this root (see `getOutputDirectory`),
        // so module paths resolve relative to it and the framework's
        // cross-environment imports stay intact.
        const manifestDir = getManifestDir(entryOutDir, clientOutDir);
        if (!manifestDir) return;
        const manifestPath = path.join(manifestDir, BUILD_MANIFEST_NAME);

        // Start from a clean slate: a successful build emits a fresh manifest or,
        // for a pure SPA / assets-only build with no worker entry, none — never a
        // stale one.
        fs.rmSync(manifestPath, { force: true });

        if (!entryOutDir || !mainFileName) return;

        const modules = Array.from(
          new Map(
            workerEnvNames
              .map(resolveOutDir)
              .filter((dir): dir is string => dir !== undefined)
              .flatMap((dir) => listModules(dir, manifestDir))
              .map((module) => [module.path, module]),
          ).values(),
        ).sort((a, b) => a.path.localeCompare(b.path));

        // Every Worker output must live under the manifest root. A module that
        // escapes it means the entry and child environments were written to
        // different roots — which the framework's baked cross-environment
        // imports can't satisfy either. That happens with a custom
        // `build.outDir` under the child-environment (RSC) topology; the result
        // isn't deployable, so emit nothing rather than a broken manifest.
        const escaping = modules.filter((module) => module.path.startsWith("../"));
        if (escaping.length > 0) {
          builder.config.logger.warn(
            `[cloudflare] skipping ${BUILD_MANIFEST_NAME}: ${escaping.length} worker module(s) ` +
              `resolve outside the build root. A custom build.outDir is not supported with the ` +
              `child-environment (RSC) topology.`,
          );
          return;
        }

        const manifest: DistilledBuildManifest = {
          version: 2,
          workers: {
            app: {
              main: toPosix(path.relative(manifestDir, path.join(entryOutDir, mainFileName))),
              modules,
              compatibilityDate: options.compatibilityDate,
              compatibilityFlags: options.compatibilityFlags,
            },
          },
          assets: clientOutDir
            ? {
                directory: toPosix(path.relative(manifestDir, clientOutDir)),
                ...assetRoutingManifestFields(options.assets),
              }
            : undefined,
        };

        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      },
    },
  };
}

function assetRoutingManifestFields(
  assets: BuildManifestPluginOptions["assets"],
): Omit<NonNullable<DistilledBuildManifest["assets"]>, "directory"> {
  return {
    ...(assets?.htmlHandling !== undefined ? { htmlHandling: assets.htmlHandling } : {}),
    ...(assets?.notFoundHandling !== undefined
      ? { notFoundHandling: assets.notFoundHandling }
      : {}),
    ...(assets?.runWorkerFirst !== undefined ? { runWorkerFirst: assets.runWorkerFirst } : {}),
  };
}
