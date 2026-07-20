# SvelteKit — Integration Design Spec for cloudflare-tools / alchemy

Submodule analyzed: `upstream/sveltekit` @ `8f5b9c72ae930b3b93ef9e1b9ecb9e52664e1d74` (2026-07-20, "fix: populate `version` in service workers (#16434)").
Packages of interest:

- `packages/kit` — `@sveltejs/kit` **3.0.0-next.11** (`packages/kit/package.json`). Peer deps: `vite ^8.0.12` (rolldown-vite), `@sveltejs/vite-plugin-svelte ^7.0.0`, `svelte ^5.56.4`.
- `packages/adapter-cloudflare` — `@sveltejs/adapter-cloudflare` **8.0.0-next.2** (`packages/adapter-cloudflare/package.json`). Peer dep: `wrangler ^4.67.0`.

All file paths below are relative to the submodule root unless prefixed with `cloudflare-tools/`.

---

## TL;DR

- **SvelteKit is purely a Vite plugin.** `sveltekit()` (`packages/kit/src/exports/vite/index.js:169`) returns `Promise<Plugin[]>`. There is no framework CLI for dev/build: `vite dev` and `vite build` are the entrypoints, so `vite.createServer()` / `vite.createBuilder().buildApp()` — exactly the shape of our `Vite.ts` exemplar — are the programmatic API. The `svelte-kit` bin (`packages/kit/svelte-kit.js` → `src/cli.js`) only implements `sync` (typegen).
- **Since kit v3, config is passed directly to `sveltekit(config)`** and a `svelte.config.js` on disk is a **hard error** (`packages/kit/src/exports/vite/index.js:236-243`). This is ideal for us: the entire config surface, including the adapter instance, is generated in memory.
- **Build is a single Vite builder run** using the modern Environment API: `buildApp` builds `ssr` → analyse → `client` → prerender → (`serviceWorker`) → adapter `adapt()`. No legacy two-invocation multi-build.
- **The Cloudflare adapter's only wrangler touchpoints are two imports** in one file: `unstable_readConfig` (config discovery) and `getPlatformProxy` (dev/preview emulation), both at `packages/adapter-cloudflare/index.js:5`. The adapter does **no bundling** (no esbuild, no wrangler spawn): the emitted `_worker.js` is a tiny shim whose relative imports into `.svelte-kit/output/server/` are left for **wrangler deploy** to bundle. That final bundling step is the main thing we must replace.
- **Adaptation verdict:** write our own ~200-line SvelteKit adapter (Effect-friendly, zero wrangler) + a small rolldown pass that bundles the worker shim through `@distilled.cloud/cloudflare-rolldown-plugin`, and drive everything from a `SvelteKit.ts` service copied from `Vite.ts`. Dev works today with SvelteKit's Node-side SSR; the emulation gap (bindings inside `platform.env`) needs a `getPlatformProxy` equivalent backed by `cloudflare-runtime`, which does not exist yet.

---

## A. Programmatic hooks

### A.1 What the "CLI" is

SvelteKit has no build/dev CLI of its own. The `svelte-kit` binary (`packages/kit/svelte-kit.js`: `#!/usr/bin/env node\nimport './src/cli.js';`) parses only a `sync` command (`packages/kit/src/cli.js`, help text: "Commands: sync — Synchronise generated type definitions"). Everything else is stock Vite:

- **dev** = `vite dev` with `sveltekit()` in `plugins`
- **build** = `vite build` with `sveltekit()` in `plugins`
- **preview** = `vite preview` (serves `.svelte-kit/output` via kit's `configurePreviewServer` hook, `packages/kit/src/exports/vite/preview/index.js`)

Therefore the reusable programmatic layer is **Vite's own public JS API** — `createServer` and `createBuilder` — the exact functions `cloudflare-tools/packages/tools/e2e/src/Vite.ts` already calls. **No CLI spawning is required.**

### A.2 The plugin entry: `sveltekit(config)`

`packages/kit/src/exports/vite/index.js:169`:

```js
/**
 * @param {KitConfig & Omit<Options, 'onwarn'> & Pick<SvelteConfig, 'vitePlugin'>} [config]
 * @returns {Promise<Plugin[]>}
 */
export async function sveltekit(config) {
	const cwd = process.cwd();
	const split = split_config(config ?? {});
	const svelte_config = validate_config(split.svelte_config);
	...
	vite_plugin_svelte = await import_peer('@sveltejs/vite-plugin-svelte', cwd);
	...
	return [plugin_root(), ...vite_plugin_svelte.svelte(inline_vps_config), ...kit({ svelte_config })];
}
```

Notes:

- **Async** — fine, Vite accepts promises inside the `plugins` array; or we `await` it ourselves before passing to `createBuilder`/`createServer`.
- Exported from the public subpath `@sveltejs/kit/vite` (used by the adapter test app `packages/adapter-cloudflare/test/apps/workers/vite.config.js:1`: `import { sveltekit } from '@sveltejs/kit/vite';`). **Public, stable API.**
- `svelte.config.js`/`svelte.config.ts` on disk throws (`plugin_root()`, `packages/kit/src/exports/vite/index.js:236-243`): *"svelte.config.js is no longer used. Please pass configuration via the `sveltekit(...)` plugin in your Vite config."* → the whole kit config (including `adapter`) is an in-memory object.
- `import_peer('@sveltejs/vite-plugin-svelte', cwd)` and `import_peer('vite', root)` (`:185`, `:359`) resolve peers relative to `process.cwd()` / the project root — same resolution concern our `Vite.ts` `load()` already handles with `createRequire`.
- The adapter can inject Vite plugins of its own via `Adapter.vite.plugins` (`packages/kit/src/exports/public.d.ts:78-84`, consumed at `packages/kit/src/exports/vite/index.js:1972`, placed **before** all kit plugins). This is a clean injection point for our own adapter.

### A.3 Production build: one `createBuilder().buildApp()` pass (Environment API, not legacy multi-build)

Kit v3 uses the Vite Environment/builder API, not the legacy "run `vite build` twice with `--ssr`" flow. The config hook (`plugin_setup.config` + `plugin_compile.config`) declares three environments and enables shared builds:

- `builder: { sharedConfigBuild: true, sharedPlugins: true }` — `packages/kit/src/exports/vite/index.js:1411-1414`
- `environments.ssr`: `outDir: '${out}/server'` (i.e. `.svelte-kit/output/server`), `target: 'node22'`, `rolldownOptions.input = server_input`, `entryFileNames '[name].js'`, `chunkFileNames 'chunks/[name].js'` — `:1416-1435`
- `environments.client`: `outDir: '${out}/client'`, entry names `${appDir}/immutable/[name].[hash].js` — `:1436-1464`
- `environments.serviceWorker` (only if `src/service-worker.{js,ts}` exists): `outDir: '${out}/client'` — `:1067-1095`

`server_input` (`:1286-1343`) includes `index: ${runtime_directory}/server/index.js` (exports the `Server` class), `internal`, `env`, `remote-entry`, one entry per endpoint/page node under `entries/…`, hooks, params, and optional `instrumentation.server`.

The orchestration lives in `plugin_compile.buildApp(builder)` (`packages/kit/src/exports/vite/index.js:1564-1953`):

```js
async buildApp(builder) {
	if (!builder.config.build.watch) rimraf(out);
	...
	const { output: server_chunks } = await builder.build(builder.environments.ssr);   // 1. server
	...
	const { metadata } = await analyse({ ... });                                        // 2. route analysis
	...
	await builder.build(builder.environments.client);                                   // 3. client
	...
	prerender_results = await prerender({ ... });                                       // 4. prerender
	...
	finalise = async () => {
		if (service_worker_entry_file) await builder.build(builder.environments.serviceWorker); // 5. SW
		if (kit.adapter) {
			const { adapt } = await import('../../core/adapt/index.js');
			await adapt(svelte_config, build_data, metadata, prerendered, ...);            // 6. adapter
		}
	};
}
```

`finalise` is invoked by a second plugin, `plugin_adapter`, whose `buildApp` hook has `order: 'post'` so it runs after every other plugin's `buildApp` (`packages/kit/src/exports/vite/index.js:1956-1968`). All of this is triggered by a plain:

```ts
const builder = await vite.createBuilder(inlineConfig, null);
await builder.buildApp();
```

— identical to `Vite.ts`'s `build` (`cloudflare-tools/packages/tools/e2e/src/Vite.ts:218-234`). **Public API, no internal imports.**

Intermediate output tree (before the adapter runs), all under `kit.outDir` (default `.svelte-kit`):

```
.svelte-kit/output/server/        index.js, internal.js, env.js, remote-entry.js,
                                  entries/**, chunks/**, manifest.js, manifest-full.js,
                                  .vite/manifest.json, [instrumentation.server.js]
.svelte-kit/output/client/        _app/immutable/**, .vite/manifest.json, [service-worker.js]
.svelte-kit/output/prerendered/   pages/**, dependencies/**, data/**
```

(`manifest.js` written at `:1888-1900`; prerendered layout per `builder.writePrerendered`, `packages/kit/src/core/adapt/builder.js:214-222`.)

### A.4 Dev server

`plugin_compile.configureServer` (`packages/kit/src/exports/vite/index.js:1524-1526`) delegates to `dev()` (`packages/kit/src/exports/vite/dev/index.js:44`). Mechanics:

- SSR is executed **in the Node process** via `vite.ssrLoadModule` (`dev/index.js:84`, `:548-556`) — kit builds an in-memory `SSRManifest` whose node loaders lazily `ssrLoadModule` route modules (`:155-328`), instantiates `new Server(manifest)` per request (`:562`), and calls `server.respond(request, { ..., emulator })` (`:596-615`) from a Connect middleware. **It does not use Vite environments, module runners, or workerd in dev.**
- Platform emulation: `const emulator = await svelte_config.kit.adapter?.emulate?.();` (`dev/index.js:478`); same in preview (`preview/index.js:65`). The `Emulator` contract is `{ platform?({ config, prerender }): MaybePromise<App.Platform> }` (`packages/kit/src/exports/public.d.ts:351-358`).
- Programmatic invocation is exactly `Vite.ts`'s `dev`: `const server = await vite.createServer(config); await server.listen();` then `server.resolvedUrls.local[0]` for the URL and `server.close()` for shutdown. No kit-specific extras needed.

### A.5 Config injection options

Everything can be supplied through the two in-memory objects:

1. **Vite `InlineConfig`** — root, mode, port, extra plugins, `configFile: false` to ignore any on-disk `vite.config.ts`.
2. **`sveltekit(config)` argument** — the full `KitConfig` (adapter, `files`, `outDir`, `paths`, `prerender`, `output.bundleStrategy`, etc.) plus pass-through options for `vite-plugin-svelte`.

No file on disk is strictly required except the app source itself (`src/routes/**`, `src/app.html`). (If the target project has its own `vite.config.ts` calling `sveltekit(...)`, we can instead load it the way Vite normally does and only *add* our plugin — see §C.)

---

## B. Cloudflare integration (`@sveltejs/adapter-cloudflare`)

One package, one runtime shim, ~300 lines. Entry: `packages/adapter-cloudflare/index.js`, default export returns an `Adapter` (`packages/kit/src/exports/public.d.ts:43-81`):

```js
import { getPlatformProxy, unstable_readConfig } from 'wrangler';   // index.js:5  ← the ONLY wrangler imports

export default function (options = {}) {
	return {
		name: '@sveltejs/adapter-cloudflare',
		async adapt(builder) { ... },      // index.js:20
		emulate() { ... },                 // index.js:181
		supports: { read: () => true, instrumentation: () => true }  // index.js:215
	};
}
```

### B.1 `adapt(builder)` — what a production build emits

Runs inside kit's `finalise` (see §A.3, so effectively "in `buildApp`, post everything"; there is no `closeBundle` involvement). Steps, with line refs into `packages/adapter-cloudflare/index.js`:

1. **Read wrangler config** — `validate_wrangler_config(options.config)` (`:42`, defined `:280-295`) calls `unstable_readConfig({ config: config_file })` (`:281`). Mode detection in `packages/adapter-cloudflare/utils.js:7-17` (`is_building_for_cloudflare_pages`): `CF_PAGES` env or `pages_build_output_dir` ⇒ Pages; `WORKERS_CI` env or `main` or `assets` keys ⇒ Workers; **no wrangler config at all ⇒ defaults to Pages mode**. Workers mode additionally requires `main` + `assets.directory` + `assets.binding` in wrangler config (`validate_worker_settings`, `utils.js:22-53`).
2. **Resolve destinations** (`:46-70`): default `dest = builder.getBuildDirectory('cloudflare')` = `.svelte-kit/cloudflare` (`packages/kit/src/core/adapt/builder.js:191-193`), `worker_dest = ${dest}/_worker.js`, assets binding name default `'ASSETS'`. Workers mode overrides these from `wrangler_config.main` / `assets.directory` / `assets.binding`.
3. **Static assets** (`:81-105`): `builder.writeClient(assets_dest)` (copies `.svelte-kit/output/client` minus `.vite`, `builder.js:207-212`) + `builder.writePrerendered(assets_dest)` (`builder.js:214-222`), where `assets_dest = dest + kit.paths.base`. Optional `404.html` (plaintext or SPA fallback via `builder.generateFallback`) and SPA `index.html` depending on `assets.not_found_handling`.
4. **Worker entry** (`:107-132`): writes `${tmp}/manifest.js` (`tmp = .svelte-kit/cloudflare-tmp`) containing `export const manifest = ${builder.generateManifest(...)}`, `prerendered` set, and `base_path`; then **copies the prebuilt shim** `files/worker.js` to `worker_dest` with **regex word-boundary string replacement** (`builder.copy(..., { replace })`, implemented at `packages/kit/src/utils/filesystem.js:43-70`):
   - `SERVER` → `./<rel>/output/server/index.js`
   - `MANIFEST` → `./<rel>/cloudflare-tmp/manifest.js`
   - `ASSETS` → the assets binding name
   `files/worker.js` is prebuilt at publish time by rolldown from `src/worker.js` with `external: ['SERVER', 'MANIFEST', 'cloudflare:workers']`, `platform: 'browser'` (`packages/adapter-cloudflare/rolldown.config.js`; note `files/` is gitignored in the submodule — only `src/worker.js` is present). **The adapter does not bundle the app.** `_worker.js` is a ~100-line module that `import { Server } from './../output/server/index.js'` — the deep, many-chunk server graph stays where kit built it, and **`wrangler deploy` is what bundles the final worker**. If there is a `src/instrumentation.server.js`, `builder.instrument({ entrypoint: worker_dest, ... })` wraps the entry (`:127-132`).
5. **`_headers` / `_redirects`** (`:134-154`): merges user files from project root with generated rules (`generate_headers` `:227-241` adds `X-Robots-Tag: noindex` + immutable cache-control for `/${appDir}/*`; `generate_redirects` `:247-258` appends prerendered redirects).
6. **`_routes.json` — Pages mode only** (`:156-176`): `get_routes_json(builder, client_assets, redirects, options.routes)` (`packages/adapter-cloudflare/utils.js:90-165`) emits `{ version: 1, include: ['/*'], exclude: [<build>/<files>/<prerendered>/<redirects> expansions] }` capped at 100 rules. **Workers mode instead writes `.assetsignore`** (`:177-179`, content `_worker.js`, `_routes.json`, `_headers`, `_redirects` — `generate_assetsignore` `:263-271`) and relies on Workers static-asset routing (`assets.not_found_handling`, `run_worker_first` etc. from wrangler config).

Resulting Workers-mode layout with the default (no wrangler `main`/`assets` override — note that literally requires a wrangler config to even select Workers mode, see risk R2):

```
.svelte-kit/cloudflare/           ← static assets dir (upload as assets)
  _app/immutable/**  …client build
  <prerendered pages/data>
  _headers  _redirects  .assetsignore  [404.html|index.html]
  _worker.js                      ← worker entry (unbundled shim)
.svelte-kit/cloudflare-tmp/manifest.js
.svelte-kit/output/server/**      ← real server code, imported relatively by _worker.js
```

### B.2 The runtime shim (`packages/adapter-cloudflare/src/worker.js`)

```js
import { Server } from 'SERVER';
import { manifest, prerendered, base_path } from 'MANIFEST';
import { env } from 'cloudflare:workers';
import * as Cache from 'worktop/cfw.cache';

const server = new Server(manifest);
const initialized = server.init({ env, read: async (file) => (await env.ASSETS.fetch(`${origin}/${file}`)).body });

export default {
	async fetch(req, env, ctx) {
		...
		if (is_static_asset || prerendered.has(pathname) || ...) res = await env.ASSETS.fetch(req);
		else res = await server.respond(req, {
			platform: { env, ctx, caches, cf: req.cf },
			getClientAddress: () => req.headers.get('cf-connecting-ip')
		});
		return pragma && res.status < 400 ? Cache.save(req, res, ctx) : res;
	}
};
```

Bindings/env access pattern: the worker passes the **raw workerd `env`** into `server.init({ env })` (kit splits it into `$env/dynamic/private`/`public` by prefix) and exposes `platform = { env, ctx, caches, cf }` to user `load`/endpoint code (`App.Platform`). Static assets and prerendered pages are served via the **`ASSETS` binding fetch** (`src/worker.js:25, 84`). Response caching uses `worktop/cfw.cache` (dependency, `package.json:46-49`). `cloudflare:workers` is imported for module-level `env` (`src/worker.js:3`).

### B.3 Dev/preview emulation

`emulate()` (`packages/adapter-cloudflare/index.js:181-214`) lazily calls **`getPlatformProxy(options.platformProxy)` from `wrangler`** (`:185`) — i.e. wrangler boots a miniflare/workerd instance in the background and hands Node-side proxy objects back:

```js
const proxy = await getPlatformProxy(options.platformProxy);
const platform = { env: proxy.env, ctx: proxy.ctx, caches: proxy.caches, cf: proxy.cf };
```

It also builds a `prerender_platform` whose `env` getters throw ("Cannot access platform.env.X in a prerenderable route", `:193-203`). The returned `Emulator.platform({ prerender })` picks between them (`:208-213`). Kit calls this in dev (`packages/kit/src/exports/vite/dev/index.js:478`, passed into `server.respond` at `:614`) and preview (`packages/kit/src/exports/vite/preview/index.js:65`). `getPlatformProxy` itself reads wrangler.json for binding definitions (its options accept `configPath`, `environment`, `persist`).

### B.4 Exhaustive wrangler coupling inventory

| Touchpoint | Location | Purpose |
| --- | --- | --- |
| `import { unstable_readConfig } from 'wrangler'` | `packages/adapter-cloudflare/index.js:5`, used `:281` | Read wrangler.json → Pages-vs-Workers mode, `main`, `assets.directory`, `assets.binding`, `pages_build_output_dir`, `assets.not_found_handling`, `configPath` |
| `import { getPlatformProxy } from 'wrangler'` | `packages/adapter-cloudflare/index.js:5`, used `:185` | Dev/preview `platform.env/ctx/caches/cf` emulation (spawns miniflare workerd under the hood) |
| `import('wrangler').Unstable_Config` / `GetPlatformProxyOptions` types | `packages/adapter-cloudflare/index.d.ts:3`, `utils.js:4,20` | Types only |
| `peerDependencies: { wrangler: '^4.67.0' }` | `packages/adapter-cloudflare/package.json:60` | — |
| Implicit: deploy-time bundling of `_worker.js` | (not in repo — `wrangler deploy` behavior) | The adapter's output is *not deployable* without a bundler because `_worker.js` imports `.svelte-kit/output/server/**` and `worktop` from `node_modules` |

`packages/kit` itself has **zero** wrangler/cloudflare dependencies (its `App.Platform` is an opaque generic). No wrangler CLI is ever spawned by either package.

---

## C. Adaptation plan for cloudflare-tools + alchemy

Target: a `SvelteKit` Effect `Context.Service` mirroring `Vite.ts` (`cloudflare-tools/packages/tools/e2e/src/Vite.ts:31-44`): `{ build, dev, readBuildOutput }` producing `BuildOutput = { clientDirectory, serverModules (entry first), externalWorkspaces }`, dev running against `@distilled.cloud/cloudflare-runtime`, **no wrangler, no wrangler.json**.

### C.1 Can our cloudflare-vite-plugin drive SvelteKit's build directly, or do we wrap the adapter?

**Neither composes as-is; we replace the adapter.** Reasons:

1. Our plugin assumes the worker **is** a Vite environment build output (`viteEnvironments.entry`, default `ssr` — `cloudflare-tools/packages/cloudflare-rolldown-plugin/src/options.ts:43-47`), and `Vite.ts`'s `output` plugin collects `writeBundle` chunks per environment. SvelteKit's `ssr` environment output (`.svelte-kit/output/server/**`) is an *intermediate*: the deployable entry (`_worker.js`) and `manifest.js` are produced afterwards inside `adapt()` by file copy + string replacement, invisible to `writeBundle`. Capturing `ssr` chunks alone yields a worker without manifest, prerender data, headers, or the assets-serving shim.
2. Applying our plugin's workerd resolve conditions to kit's `ssr` environment would fight kit's own enforced env config (`target: 'node22'`, `packages/kit/src/exports/vite/index.js:1420`; kit warns on/overrides conflicting config via `enforced_config`, `:74-107`). Upstream `@sveltejs/adapter-cloudflare` itself accepts node-resolved server output and lets wrangler re-bundle it; we should do the same rather than re-litigate kit's build.
3. In dev, our plugin runs the ssr environment in workerd via module runner, but kit's dev SSR is hardwired to Node `vite.ssrLoadModule` + Connect middleware (§A.4). Forcing kit's dev into workerd means reimplementing `packages/kit/src/exports/vite/dev/index.js` (725 lines, deeply coupled to Node fs/module-graph APIs) — not worth it; even Cloudflare's official `@cloudflare/vite-plugin` doesn't do it for SvelteKit (SvelteKit users use adapter `emulate()` + `getPlatformProxy`).

So the design is: **keep `sveltekit()` untouched; supply our own `Adapter` object** (the adapter interface is tiny, public, and stable: `name`, `adapt(builder)`, `emulate()`, `supports`, optional `vite.plugins` — `packages/kit/src/exports/public.d.ts:43-81`).

### C.2 Proposed package: `@distilled.cloud/sveltekit` (or a module inside tools/e2e first)

**(a) `build(options, viteConfig)`**

```ts
const kitPlugins = await sveltekit({
  adapter: distilledCloudflareAdapter(adapterOptions),  // ours, in-memory
  ...userKitConfig,
});
const builder = await vite.createBuilder({ ...config, configFile: false, plugins: [...(config?.plugins ?? []), kitPlugins] }, null);
await builder.buildApp();
```

Our `distilledCloudflareAdapter(options).adapt(builder)` — a fork of `packages/adapter-cloudflare/index.js` with the wrangler parts excised:

- **Reuse as-is** (fork-copy, near verbatim): asset writing (`builder.writeClient` / `writePrerendered` / `generateFallback`), `manifest.js` generation via `builder.generateManifest`, the runtime shim `src/worker.js` (we can bundle it ourselves with rolldown at our package's build time, same `external: ['SERVER','MANIFEST','cloudflare:workers']` config as `packages/adapter-cloudflare/rolldown.config.js`), `_headers`/`_redirects` generation (`generate_headers`, `generate_redirects`), `.assetsignore`, `builder.instrument` support.
- **Delete**: `unstable_readConfig` + `validate_wrangler_config` + `is_building_for_cloudflare_pages` — we are **always Workers mode**; `dest`, `assets binding name`, and `not_found_handling` become plain adapter options with defaults (`dest: .svelte-kit/cloudflare`, `binding: 'ASSETS'`). Drop the Pages branch and `_routes.json` entirely (Workers static assets don't use it).
- **Add**: a final **bundling pass** replacing wrangler-deploy's role. After writing `_worker.js`, run rolldown programmatically with `@distilled.cloud/cloudflare-rolldown-plugin` (input `_worker.js`, platform-appropriate conditions, `external: ['cloudflare:workers']`), emitting entry-first chunks. Two placement options:
  - run it inside `adapt()` and stash results on the adapter instance, or
  - have `adapt()` only *record paths* and let the Effect service run the rolldown pass afterward (cleaner error channel). Recommended.

  This pass inlines `worktop/cfw.cache`, `manifest.js`, and the whole `.svelte-kit/output/server` graph, resolving the "relative imports escape the assets dir" problem in one shot.

**(b) `BuildOutput` mapping**

| `Vite.ts` field | SvelteKit source |
| --- | --- |
| `clientDirectory` | `.svelte-kit/cloudflare` — the adapter `dest`: client immutable assets **+ prerendered pages/data + `_headers` + `_redirects` + `.assetsignore`** (upload wholesale as the Worker's assets directory; `.assetsignore` already excludes the non-asset files) |
| `serverModules` (entry first) | chunks from our rolldown pass over `_worker.js` (entry chunk first, then remaining chunks sorted, matching `collectServerModules` in `Vite.ts:181-196`); hash with the same sha-256 `toOutputFile` helper |
| `externalWorkspaces` | from the rolldown pass module ids, same filter as `Vite.ts:130-136` (absolute, not under root, not node_modules → nearest `package.json` dir) |

**(c) `dev(options, viteConfig)`**

```ts
const server = await vite.createServer({ ...config, plugins: [await sveltekit({ adapter: distilledCloudflareAdapter(options), ... })] });
await server.listen();  // url = server.resolvedUrls.local[0]; release = server.close()
```

SSR runs in Node (kit's own dev path, full HMR). Cloudflare-ness comes from our adapter's `emulate()`:

- **Phase 1 (works today, zero new runtime code):** `emulate()` returns `{ platform: () => ({ env: { ...process.env-ish vars, ASSETS: stubFetch }, ctx: { waitUntil, passThroughOnExit }, caches: noopCaches, cf: {} }) }`. Enough for apps that only use `platform.env` vars and `ctx.waitUntil`. Keep the prerender-env-guard behavior from upstream (`index.js:193-203`).
- **Phase 2 (the real replacement for `getPlatformProxy`):** a `cloudflare-runtime` feature that boots workerd with the requested bindings plus a small loopback/RPC worker, and exposes Node-side proxy objects for `env` (KV/R2/D1/DO/etc.), `caches`, and `cf`. `cloudflare-runtime` has all the binding plugins (`src/bindings/**`) and a `WorkerProxy` HTTP proxy (`src/proxy/WorkerProxy.ts`) but **no Node-side binding proxy today** — this is net-new work (miniflare implements it as the "magic proxy" over a special proxy worker; we'd mirror that pattern). Bindings are declared in our adapter options / plugin options in memory — never wrangler.json.

**(d) `readBuildOutput`** — identical to `Vite.ts:280-292` (`dist/build.json` snapshot).

### C.3 Config surface we generate in-memory (instead of wrangler.json)

| wrangler.json key (upstream) | Our replacement |
| --- | --- |
| `main` | not needed — worker entry is always our generated `_worker.js` |
| `assets.directory` | adapter option `dest` (default `.svelte-kit/cloudflare`), flows into `BuildOutput.clientDirectory` |
| `assets.binding` | adapter option `assetsBinding` (default `'ASSETS'`), string-replaced into the shim |
| `assets.not_found_handling` | adapter option `notFoundHandling: 'none' | '404-page' | 'single-page-application'` driving the 404.html/index.html fallback generation |
| `compatibility_date` / `compatibility_flags` | `CloudflareVitePluginOptions`/deploy config (alchemy Worker props); the shim needs `cloudflare:workers` module-level `env`, so compat date ≥ 2025-xx with `nodejs_compat` unnecessary |
| bindings (KV/R2/D1/DO/…) for dev | our runtime's `RuntimeWorker` binding declarations passed to `emulate()`'s Phase-2 provider |
| `pages_build_output_dir` | dropped (no Pages support) |

### C.4 What we reuse vs fork vs build new

- **Reuse untouched (upstream npm deps):** `@sveltejs/kit` (`sveltekit()` plugin, `Builder` API), `@sveltejs/vite-plugin-svelte`, vite `createBuilder`/`createServer`.
- **Fork (small, vendored into our package):** `packages/adapter-cloudflare/index.js` minus wrangler (≈150 lines survive), `src/worker.js` shim (≈115 lines), `utils.js` `append_headers`/`parse_redirects` (skip `_routes.json` + wrangler validators). License MIT.
- **Build new:** the rolldown bundling pass wired to `cloudflare-rolldown-plugin`; the Effect `SvelteKit` service; (Phase 2) the Node-side bindings proxy in `cloudflare-runtime`.

### C.5 Effort estimate

**Medium.** The build path is a weekend-scale port (the adapter is tiny and the shim is self-contained; our `Vite.ts` machinery transfers almost verbatim). The only genuinely new engineering is the `getPlatformProxy` replacement in `cloudflare-runtime` (Phase 2 dev bindings), which is independent and can ship later.

### C.6 Risks & unknowns

- **R1 — Pre-release churn.** kit `3.0.0-next.11` / adapter `8.0.0-next.2`: the v3 config API (`sveltekit(config)`, `Adapter.vite.plugins`, `buildApp` ordering) is new and may shift before stable. The `Builder` interface is documented-stable; the buildApp orchestration is internal.
- **R2 — Upstream Workers/Pages mode default.** With no wrangler config, upstream defaults to **Pages** output (`utils.js:7-17`). Our fork hardcodes Workers mode — behavior intentionally diverges from upstream defaults; document it.
- **R3 — Node-flavored server output.** Kit builds the `ssr` env with `target: 'node22'` and node resolve conditions; wrangler today bundles that same output for workerd successfully, but our rolldown pass must match wrangler's alias/conditions behavior (e.g. `esm-env` is force-inlined by kit precisely so later bundlers don't mis-resolve it — `packages/kit/src/exports/vite/index.js:459-471`). Some npm deps resolved for node may still smuggle in node builtins; our `nodejs_compat`/unenv handling in `cloudflare-rolldown-plugin` covers most, but this is the top functional risk for real apps.
- **R4 — Dev fidelity gap (Phase 1).** Until the bindings proxy exists, `platform.env` bindings (KV/R2/D1/DO) are stubs in dev; apps relying on them need Phase 2. Also `read()` from `$app/server` in dev reads from the filesystem (fine), but in prod goes through `ASSETS.fetch` — covered by the shim.
- **R5 — `worktop` dependency.** The shim imports `worktop/cfw.cache` (pinned `0.8.0-next.18`); our rolldown pass must resolve it (add as dependency of our package) or we replace it with a ~30-line `caches.default` wrapper to drop the dep.
- **R6 — `files/worker.js` is a publish-time artifact.** The submodule only has `src/worker.js`; our fork must run its own rolldown prebuild (config exists at `packages/adapter-cloudflare/rolldown.config.js` to copy).
- **R7 — `process.cwd()` sensitivity.** `sveltekit()` resolves peers and reads user `_headers`/`_redirects` relative to cwd (`index.js:170`, adapter `:139-148`); our service must run with cwd = project root (Vite.ts's `Runtime.Cwd` already models this).
- **R8 — Service workers + `emulate()` interplay** and instrumentation entry wrapping are lightly-tested corners upstream; verify with e2e fixtures (upstream has `packages/adapter-cloudflare/test/apps/{workers,pages}` we can crib).
