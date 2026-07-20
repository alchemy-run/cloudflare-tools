/**
 * In-memory SvelteKit `Adapter` — a wrangler-free fork of
 * `@sveltejs/adapter-cloudflare`'s `adapt()`.
 *
 * Differences from upstream:
 *
 * - No `unstable_readConfig` / wrangler.json: always Workers mode with plain
 *   options (`dest` fixed to kit's `cloudflare` build directory, assets
 *   binding defaults to `ASSETS`).
 * - No Pages mode, no `_routes.json`.
 * - The worker shim is generated directly with real relative import paths
 *   (see `WorkerShim.ts`); upstream ships a prebuilt `files/worker.js` and
 *   string-replaces `SERVER`/`MANIFEST` placeholders.
 * - `emulate()` returns a stub platform (env from in-memory options,
 *   `ctx.waitUntil` no-op, no-op `caches`, empty `cf`) instead of wrangler's
 *   `getPlatformProxy`. Real dev bindings arrive with the
 *   `cloudflare-runtime` Node-side bindings proxy.
 *
 * The adapter does **not** bundle the app: `adapt()` records the assets
 * directory and the unbundled worker entry on `result`, and the `SvelteKit`
 * Framework service runs the rolldown pass afterwards (replacing the bundling
 * `wrangler deploy` performs for the upstream adapter).
 *
 * Note: this module runs as a SvelteKit build callback (kit calls `adapt()`
 * inside Vite's `buildApp`), so it uses kit's synchronous `Builder` API and
 * `node:fs` directly like upstream — it is framework-callback code, not an
 * Effect service.
 */
import type { Adapter, Builder, Emulator } from "@sveltejs/kit";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { generateWorkerShim } from "./WorkerShim.ts";

export interface CloudflareAdapterResult {
  /**
   * The static-assets directory (client build + prerendered pages +
   * `_headers`/`_redirects`/`.assetsignore`) — upload wholesale as the
   * Worker's assets directory; becomes `BuildOutput.clientDirectory`.
   */
  readonly dest: string;
  /** The generated (unbundled) worker entry — input for the rolldown pass. */
  readonly workerEntry: string;
}

export interface CloudflareAdapterOptions {
  /**
   * Name of the static-assets binding the worker shim serves files through.
   * @default "ASSETS"
   */
  readonly assetsBinding?: string | undefined;
  /**
   * Mirror of Workers static assets `not_found_handling`, driving fallback
   * page generation: `"404-page"` writes `404.html`,
   * `"single-page-application"` writes `index.html`.
   * @default "none"
   */
  readonly notFoundHandling?: "none" | "404-page" | "single-page-application" | undefined;
  /**
   * With `notFoundHandling: "404-page"`: `"spa"` renders the app shell as the
   * fallback, `"plaintext"` writes a plain `Not Found` page.
   * @default "plaintext"
   */
  readonly fallback?: "spa" | "plaintext" | undefined;
  /**
   * Project root used to locate user-authored `_headers` / `_redirects`
   * files.
   * @default process.cwd()
   */
  readonly root?: string | undefined;
  /**
   * Values for the dev-server stub platform returned from `emulate()`:
   * `platform.env` entries visible to `load` functions and endpoints in dev.
   */
  readonly platform?: { readonly env?: Record<string, unknown> | undefined } | undefined;
}

export interface CloudflareAdapter extends Adapter {
  /** Populated by `adapt()`; consumed by the SvelteKit Framework service. */
  readonly result: { current?: CloudflareAdapterResult };
}

export const makeCloudflareAdapter = (
  options: CloudflareAdapterOptions = {},
): CloudflareAdapter => {
  const result: { current?: CloudflareAdapterResult } = {};
  return {
    name: "@distilled.cloud/sveltekit",
    result,
    async adapt(builder: Builder) {
      const root = options.root ?? process.cwd();
      const assetsBinding = options.assetsBinding ?? "ASSETS";
      const dest = builder.getBuildDirectory("cloudflare");
      const tmp = builder.getBuildDirectory("cloudflare-tmp");

      builder.rimraf(dest);
      builder.rimraf(tmp);
      builder.mkdirp(dest);
      builder.mkdirp(tmp);

      // client assets and prerendered pages
      const assetsDest = dest + builder.config.kit.paths.base;
      builder.mkdirp(assetsDest);
      if (options.notFoundHandling === "404-page") {
        // generate plaintext 404.html first, which can then be overridden by
        // prerendering if the user defined such a page
        const fallback = NodePath.join(assetsDest, "404.html");
        if (options.fallback === "spa") {
          await builder.generateFallback(fallback);
        } else {
          NodeFs.writeFileSync(fallback, "Not Found");
        }
      }
      builder.writeClient(assetsDest);
      builder.writePrerendered(assetsDest);
      if (options.notFoundHandling === "single-page-application") {
        await builder.generateFallback(NodePath.join(assetsDest, "index.html"));
      }

      // manifest module
      NodeFs.writeFileSync(
        NodePath.join(tmp, "manifest.js"),
        `export const manifest = ${builder.generateManifest({
          relativePath: posixify(NodePath.relative(tmp, builder.getServerDirectory())),
        })};\n\n` +
          `export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});\n\n` +
          `export const base_path = ${JSON.stringify(builder.config.kit.paths.base)};\n`,
      );

      // worker entry (unbundled shim; relative imports into `output/server`)
      const workerEntry = NodePath.join(dest, "_worker.js");
      NodeFs.writeFileSync(
        workerEntry,
        generateWorkerShim({
          serverImport: `./${posixify(NodePath.relative(dest, builder.getServerDirectory()))}/index.js`,
          manifestImport: `./${posixify(NodePath.relative(dest, tmp))}/manifest.js`,
          assetsBinding,
        }),
      );
      if (
        typeof builder.hasServerInstrumentationFile === "function" &&
        builder.hasServerInstrumentationFile()
      ) {
        builder.instrument({
          entrypoint: workerEntry,
          instrumentation: NodePath.join(builder.getServerDirectory(), "instrumentation.server.js"),
        });
      }

      // _headers
      const userHeaders = readOptionalFile(NodePath.join(root, "_headers"));
      NodeFs.writeFileSync(
        NodePath.join(dest, "_headers"),
        generateHeaders(builder.getAppPath(), userHeaders),
      );

      // _redirects
      const userRedirects = readOptionalFile(NodePath.join(root, "_redirects"));
      const redirects = generateRedirects(builder.prerendered.redirects, userRedirects);
      if (redirects !== undefined) {
        NodeFs.writeFileSync(NodePath.join(dest, "_redirects"), redirects);
      }

      // Workers-mode assets ignore file
      NodeFs.writeFileSync(NodePath.join(dest, ".assetsignore"), generateAssetsIgnore());

      result.current = { dest, workerEntry };
    },
    emulate: () => makeStubEmulator(options.platform?.env),
    supports: {
      read: () => true,
      instrumentation: () => true,
    },
  };
};

const readOptionalFile = (path: string): string | undefined =>
  NodeFs.existsSync(path) ? NodeFs.readFileSync(path, "utf8") : undefined;

const posixify = (str: string): string => str.replace(/\\/g, "/");

/**
 * Add a rule block for `url` to a `_headers` file, merging into an existing
 * block for the same URL if present (upstream `append_headers`).
 */
export const appendHeaders = (url: string, rules: Array<string>, content: string): string => {
  const regex = new RegExp(`^(${url.replaceAll("*", "\\*")})$`, "m");
  const formattedHeaders = rules.map((rule) => `  ${rule}`).join("\n");

  // if the URL already exists, just add header rules to it
  if (regex.test(content)) {
    return content.replace(regex, `$1\n${formattedHeaders}`);
  }

  // otherwise, we add the url and header rules
  return `
${content}
# === START AUTOGENERATED SVELTE IMMUTABLE HEADERS ===
${url}
${formattedHeaders}
# === END AUTOGENERATED SVELTE IMMUTABLE HEADERS ===
`.trim();
};

/**
 * Merge the user's `_headers` content with the generated kit rules
 * (`noindex` for the app dir, immutable caching for hashed assets).
 */
export const generateHeaders = (appDir: string, content = ""): string => {
  content = appendHeaders(
    `/${appDir}/*`,
    ["X-Robots-Tag: noindex", "Cache-Control: no-cache"],
    content,
  );
  content = appendHeaders(
    `/${appDir}/immutable/*`,
    ["! Cache-Control", "Cache-Control: public, immutable, max-age=31536000"],
    content,
  );
  return content;
};

/**
 * Merge the user's `_redirects` content with rules for kit's prerendered
 * redirects. Returns `undefined` when there is nothing to write.
 */
export const generateRedirects = (
  redirects: Map<string, { status: number; location: string }>,
  content?: string,
): string | undefined => {
  const parts: Array<string> = [];
  if (content !== undefined) {
    parts.push(content);
  }
  if (redirects.size > 0) {
    const rules = Array.from(
      redirects.entries(),
      ([path, redirect]) => `${path} ${redirect.location} ${redirect.status}`,
    ).join("\n");
    parts.push(
      `
# === START AUTOGENERATED SVELTE PRERENDERED REDIRECTS ===
${rules}
# === END AUTOGENERATED SVELTE PRERENDERED REDIRECTS ===
`.trimEnd(),
    );
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("\n");
};

/** Workers-mode `.assetsignore`: files in `dest` that are not static assets. */
export const generateAssetsIgnore = (): string =>
  `
_worker.js
_routes.json
_headers
_redirects
`.trimStart();

/**
 * The phase-1 dev-platform stub: `platform.env` from in-memory options,
 * `ctx.waitUntil`/`passThroughOnException` no-ops, a no-op `caches`, and an
 * empty `cf`. During prerendering, `platform.env` access throws (mirroring
 * upstream), because prerendered pages must not depend on request-time
 * bindings.
 *
 * Real bindings (KV/R2/D1/DO/`caches`/`cf`) arrive with the
 * `cloudflare-runtime` Node-side bindings proxy; this stub is the documented
 * interim.
 */
export const makeStubEmulator = (env: Record<string, unknown> = {}): Emulator => {
  const noopCache = {
    match: async () => undefined,
    put: async () => {},
    delete: async () => false,
  };
  const platform = {
    env: { ...env },
    ctx: {
      waitUntil: (_promise: Promise<unknown>) => {},
      passThroughOnException: () => {},
    },
    caches: {
      default: noopCache,
      open: async () => noopCache,
    },
    cf: {},
  };
  const prerenderEnv: Record<string, unknown> = {};
  for (const key of Object.keys(env)) {
    Object.defineProperty(prerenderEnv, key, {
      get: () => {
        throw new Error(`Cannot access platform.env.${key} in a prerenderable route`);
      },
    });
  }
  const prerenderPlatform = { env: prerenderEnv };
  return {
    platform: ({ prerender }) =>
      (prerender ? prerenderPlatform : platform) as unknown as App.Platform,
  };
};
