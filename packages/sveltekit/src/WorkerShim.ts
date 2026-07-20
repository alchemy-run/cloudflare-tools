/**
 * The generated Cloudflare Worker entry (`_worker.js`) for a SvelteKit build.
 *
 * A fork of `@sveltejs/adapter-cloudflare`'s `src/worker.js` with two
 * differences:
 *
 * - The `SERVER` / `MANIFEST` / `ASSETS` placeholders are templated directly
 *   with real relative import paths, so there is no publish-time prebundle or
 *   `builder.copy` string replacement.
 * - `worktop/cfw.cache` is replaced with an inline `caches.default` wrapper
 *   (same lookup/save semantics), dropping the dependency.
 *
 * The emitted module is *unbundled* — its imports reach into
 * `.svelte-kit/output/server/**` — and is the input for the rolldown pass
 * that produces the final workerd-ready modules.
 */
export interface WorkerShimOptions {
  /** Relative import path to kit's server entry (`.../output/server/index.js`). */
  readonly serverImport: string;
  /** Relative import path to the generated manifest module. */
  readonly manifestImport: string;
  /** Name of the static-assets binding. */
  readonly assetsBinding: string;
}

export const generateWorkerShim = (options: WorkerShimOptions): string =>
  /* js */ `
import { Server } from ${JSON.stringify(options.serverImport)};
import { manifest, prerendered, base_path } from ${JSON.stringify(options.manifestImport)};
import { env } from 'cloudflare:workers';

const server = new Server(manifest);

const app_path = \`/\${manifest.appPath}\`;
const immutable = \`\${app_path}/immutable/\`;
const version_file = \`\${app_path}/version.json\`;

// Inline pragma-cache over \`caches.default\` (replaces the upstream
// adapter's external cache dependency).
const cache = caches.default;

const is_cacheable = (res) => {
  if (res.status === 206) return false;
  const vary = res.headers.get('vary') || '';
  if (vary.includes('*')) return false;
  const control = res.headers.get('cache-control') || '';
  if (/(private|no-cache|no-store)/i.test(control)) return false;
  return true;
};

const cache_lookup = async (req) => {
  const is_head = req.method === 'HEAD';
  if (is_head) req = new Request(req, { method: 'GET' });
  let res = await cache.match(req);
  if (is_head && res) res = new Response(null, res);
  return res;
};

const cache_save = (req, res, ctx) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && is_cacheable(res)) {
    if (res.headers.has('set-cookie')) {
      res = new Response(res.body, res);
      res.headers.append('cache-control', 'private=Set-Cookie');
    }
    ctx.waitUntil(cache.put(req, res.clone()));
  }
  return res;
};

/**
 * We don't know the origin until we receive a request, but that's guaranteed
 * to happen before we call \`read\`.
 */
let origin;

const initialized = server.init({
  env,
  read: async (file) => {
    const url = \`\${origin}/\${file}\`;
    const response = await env.${options.assetsBinding}.fetch(url);
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

    // always await initialization to prevent race condition with concurrent requests
    await initialized;

    // skip cache if "cache-control: no-cache" in request
    let pragma = req.headers.get('cache-control') || '';
    let res = !pragma.includes('no-cache') && (await cache_lookup(req));
    if (res) return res;

    let { pathname, search } = new URL(req.url);
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // ignore invalid URI
    }

    const stripped_pathname = pathname.replace(/\\/$/, '');

    // files in /static, the service worker, and Vite-imported server assets
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
      res = await env.${options.assetsBinding}.fetch(req);
    } else if (location && prerendered.has(location)) {
      // trailing slash redirect for prerendered pages
      if (search) location += search;
      res = new Response('', { status: 308, headers: { location } });
    } else {
      // dynamically-generated pages
      res = await server.respond(req, {
        platform: { env, ctx, caches, cf: req.cf },
        getClientAddress() {
          return req.headers.get('cf-connecting-ip');
        },
      });
    }

    // write to the cache only if the response is not an error;
    // \`cache_save\` handles the Cache-Control and Vary headers
    pragma = res.headers.get('cache-control') || '';
    return pragma && res.status < 400 ? cache_save(req, res, ctx) : res;
  },
};
`.trimStart();
