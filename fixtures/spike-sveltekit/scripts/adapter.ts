/**
 * In-memory SvelteKit Adapter — a wrangler-free fork of
 * `@sveltejs/adapter-cloudflare`'s `adapt()` (upstream/sveltekit/packages/adapter-cloudflare/index.js).
 *
 * Differences from upstream:
 * - No `unstable_readConfig` / wrangler.json: always Workers mode, fixed defaults
 *   (dest = .svelte-kit/cloudflare, assets binding = ASSETS).
 * - No Pages mode, no `_routes.json`, no `getPlatformProxy` emulate().
 * - The worker shim is generated directly with real import paths (upstream ships a
 *   prebuilt `files/worker.js` and string-replaces SERVER/MANIFEST placeholders).
 * - `worktop/cfw.cache` is replaced with a tiny `caches.default` wrapper (spike
 *   drops the pragma-cache; the real package will port it).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Adapter, Builder } from "@sveltejs/kit";

export interface SpikeAdapterResult {
  /** assets directory to upload / serve (client + prerendered + .assetsignore) */
  dest: string;
  /** the unbundled worker entry — input for the rolldown pass */
  workerEntry: string;
}

export const result: { current?: SpikeAdapterResult } = {};

export function spikeCloudflareAdapter(): Adapter {
  return {
    name: "spike-cloudflare-adapter",
    async adapt(builder: Builder) {
      const dest = builder.getBuildDirectory("cloudflare");
      const tmp = builder.getBuildDirectory("cloudflare-tmp");

      builder.rimraf(dest);
      builder.rimraf(tmp);
      builder.mkdirp(dest);
      builder.mkdirp(tmp);

      // client assets and prerendered pages
      const assetsDest = dest + builder.config.kit.paths.base;
      builder.mkdirp(assetsDest);
      builder.writeClient(assetsDest);
      builder.writePrerendered(assetsDest);

      // manifest module
      writeFileSync(
        `${tmp}/manifest.js`,
        `export const manifest = ${builder.generateManifest({
          relativePath: posixify(path.relative(tmp, builder.getServerDirectory())),
        })};\n\n` +
          `export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});\n\n` +
          `export const base_path = ${JSON.stringify(builder.config.kit.paths.base)};\n`,
      );

      // worker entry (unbundled shim; relative imports into .svelte-kit/output/server)
      const workerEntry = `${dest}/_worker.js`;
      const serverImport = `./${posixify(path.relative(dest, builder.getServerDirectory()))}/index.js`;
      const manifestImport = `./${posixify(path.relative(dest, tmp))}/manifest.js`;
      writeFileSync(workerEntry, workerShim({ serverImport, manifestImport, assetsBinding: "ASSETS" }));

      // Workers-mode assets ignore file (upstream generate_assetsignore)
      writeFileSync(`${dest}/.assetsignore`, "_worker.js\n_routes.json\n_headers\n_redirects\n");

      result.current = { dest, workerEntry };
    },
    supports: {
      read: () => true,
    },
  };
}

const posixify = (str: string) => str.replace(/\\/g, "/");

/**
 * Fork of upstream `src/worker.js` with:
 * - SERVER/MANIFEST/ASSETS templated directly (no publish-time prebundle)
 * - `worktop/cfw.cache` removed (no pragma-cache in the spike)
 */
const workerShim = (opts: {
  serverImport: string;
  manifestImport: string;
  assetsBinding: string;
}) => /* js */ `
import { Server } from ${JSON.stringify(opts.serverImport)};
import { manifest, prerendered, base_path } from ${JSON.stringify(opts.manifestImport)};
import { env } from 'cloudflare:workers';

const server = new Server(manifest);

const app_path = \`/\${manifest.appPath}\`;
const immutable = \`\${app_path}/immutable/\`;
const version_file = \`\${app_path}/version.json\`;

let origin;

const initialized = server.init({
  env,
  read: async (file) => {
    const url = \`\${origin}/\${file}\`;
    const response = await env.${opts.assetsBinding}.fetch(url);
    if (!response.ok) {
      throw new Error(\`read(...) failed: could not fetch \${url} (\${response.status})\`);
    }
    return response.body;
  },
});

export default {
  async fetch(req, env, ctx) {
    if (!origin) {
      origin = new URL(req.url).origin;
    }
    await initialized;

    let { pathname, search } = new URL(req.url);
    try {
      pathname = decodeURIComponent(pathname);
    } catch {}

    const stripped_pathname = pathname.replace(/\\/$/, '');

    let is_static_asset = false;
    const filename = stripped_pathname.slice(base_path.length + 1);
    if (filename) {
      is_static_asset =
        manifest.assets.has(filename) || manifest.assets.has(filename + '/index.html');
    }

    let location = pathname.at(-1) === '/' ? stripped_pathname : pathname + '/';

    if (
      is_static_asset ||
      prerendered.has(pathname) ||
      pathname === version_file ||
      pathname.startsWith(immutable)
    ) {
      return env.${opts.assetsBinding}.fetch(req);
    } else if (location && prerendered.has(location)) {
      if (search) location += search;
      return new Response('', { status: 308, headers: { location } });
    }

    return server.respond(req, {
      platform: { env, ctx, caches, cf: req.cf },
      getClientAddress() {
        return req.headers.get('cf-connecting-ip');
      },
    });
  },
};
`;
