# Astro — Integration Design Spec for cloudflare-tools / alchemy

Submodule: `upstream/astro` (withastro/astro @ `5be09d64c56eb2688c5a46bf700842f28fd4e998`, 2026-07-20).
Astro core version: **7.1.2** (`packages/astro/package.json`).

> **Correction to the research brief:** `@astrojs/cloudflare` no longer lives in the separate
> `withastro/adapters` repo. As of the v14 line it is **inside this submodule** at
> `packages/integrations/cloudflare` (version **14.1.3**, identical to the published npm dist
> verified side-by-side against `@astrojs/cloudflare@14.1.3` in a local `node_modules`). All
> citations below are to the submodule source unless noted. Two other brief assumptions are
> outdated for v14: the adapter does **not** use `getPlatformProxy` (that was v12), and it does
> **not** emit the Pages-style `dist/_worker.js` + `_routes.json` layout (no `_routes.json`
> generation exists anywhere in `packages/integrations/cloudflare/src`; only a leftover route-part
> parser `getParts` in `src/utils/generate-routes-json.ts` used for `_redirects` analysis).

## TL;DR

- **Programmatic API: first-class and public.** `import { dev, build, preview, sync } from 'astro'`
  (`packages/astro/src/core/index.ts:1-17`). The CLI is a thin flag-parser over exactly these
  functions. No CLI spawning needed. Config is injected via `AstroInlineConfig`
  (`packages/astro/src/types/public/config.ts:3340-3383`), which extends the full `AstroUserConfig`
  (including `adapter`, `integrations`, `vite`) plus inline-only keys (`configFile: string | false`,
  `mode`, `logLevel`, `force`).
- **Cloudflare integration:** `@astrojs/cloudflare` v14 is an Astro *integration* that delegates
  all Cloudflare-specific work to the official **`@cloudflare/vite-plugin`** (dependency
  `^1.39.0`), which embeds **miniflare/workerd** in the Vite dev server and emits a Workers-Assets
  deploy layout on build (`dist/server/entry chunk + wrangler.json`, `dist/client/` assets,
  `.wrangler/deploy/config.json` redirect). SSR runs **inside workerd in dev** via the Vite
  module-runner — the same architecture our `@distilled.cloud/cloudflare-vite-plugin` implements
  against `cloudflare-runtime`.
- **Wrangler coupling** is real but shallow on the adapter side (one env-var loader + file
  watchers) and deep on the `@cloudflare/vite-plugin` side (config machinery, miniflare). A
  `wrangler.json` **file is optional** — the plugin falls back to
  `wrangler.unstable_defaultWranglerConfig` and the adapter fills everything else via an in-memory
  config customizer.
- **Adaptation:** fork the ~530-line adapter integration, swap `@cloudflare/vite-plugin` for our
  plugin, keep the adapter's runtime entrypoints (`entrypoints/server.ts`, `utils/handler.ts`,
  `utils/cf-helpers.ts` — zero wrangler imports) as-is, and wrap `dev()`/`build()` in an Effect
  `Context.Service` mirroring `packages/tools/e2e/src/Vite.ts`. Effort: **medium**.

---

## A. Programmatic hooks

### A.1 Public entry: the `astro` package root

`packages/astro/src/index.ts`:

```ts
export * from './core/index.js';
```

`packages/astro/src/core/index.ts` (whole file, abbreviated):

```ts
export { default as build } from './build/index.js';
export { default as dev } from './dev/index.js';
export { default as preview } from './preview/index.js';
export const sync = (inlineConfig: AstroInlineConfig) => _sync(inlineConfig);
```

Export map: `"."` → `./dist/index.js` (`packages/astro/package.json`). All four functions are
JSDoc'd `@experimental The JavaScript API is experimental` but are the documented public
"Programmatic API" of Astro and are exactly what the CLI calls — they are as stable as the CLI
itself.

### A.2 CLI → programmatic trace

- `astro build` → `packages/astro/src/cli/build/index.ts:1-37`:
  `import _build from '../../core/build/index.js'` … `await _build(flagsToAstroInlineConfig(flags), { devOutput: !!flags.devOutput })`.
- `astro dev` → `packages/astro/src/cli/dev/index.ts:3`:
  `import devServer from '../../core/dev/index.js'` (plus CLI-only lock-file/background-mode
  wrapping in the same directory — none of which is needed programmatically).
- `flagsToAstroInlineConfig` (`packages/astro/src/cli/flags.ts:11-47`) shows the CLI's entire
  configuration surface is just an `AstroInlineConfig` literal (`configFile`, `mode`, `logLevel`,
  `force`, `root`, `site`, `base`, `outDir`, `server.{port,host,open,allowedHosts}`).

There is no deeper "internal" layer to reach for: `core/dev` and `core/build` **are** the reusable
programmatic layer.

### A.3 `dev(inlineConfig)` — signature, URL/port, shutdown

`packages/astro/src/core/dev/dev.ts:42`:

```ts
export default async function dev(inlineConfig: AstroInlineConfig): Promise<DevServer>
```

`DevServer` (`dev.ts:28-34`):

```ts
export interface DevServer {
	address: AddressInfo;                       // from viteServer.httpServer.address()
	resolvedUrls: vite.ResolvedServerUrls;      // live getter → http://localhost:4321/ etc.
	handle: (req, res) => void;                 // direct vite middleware dispatch
	watcher: vite.FSWatcher;
	stop(): Promise<void>;                      // closes the container (vite server + hooks)
}
```

Internals: `dev()` calls `createContainerWithAutomaticRestart({ inlineConfig, fs })`
(`src/core/dev/restart.ts`) which builds a `Container`
(`src/core/dev/container.ts:39-152`): runs `astro:config:setup`/`astro:config:done` integration
hooks, builds the Vite config via `createVite` (`src/core/create-vite.ts`), and calls
`vite.createServer(viteConfig)` (`container.ts:121`). `startContainer` (`container.ts:162-177`)
calls `viteServer.listen(port)` and returns `AddressInfo`. `stop()` → `closeContainer` →
`viteServer.close()` + `astro:server:done` hook (`container.ts:154-160`).

Side effects to be aware of when embedding: `ensureProcessNodeEnv('development')` (mutates
`process.env.NODE_ENV`), `telemetry.record` (disable via `ASTRO_TELEMETRY_DISABLED=1`), a
non-blocking npm version check (`dev.ts:54-90`), and the content-layer sync (`dev.ts:92-125`).
`restart.bindCLIShortcuts()` (`dev.ts:130`) only attaches if stdin is a TTY.

### A.4 `build(inlineConfig, options?)`

`packages/astro/src/core/build/index.ts:50-81`:

```ts
export default async function build(inlineConfig: AstroInlineConfig, options: BuildOptions = {}): Promise<void>
```

Flow: `resolveConfig(inlineConfig, 'build')` → `createSettings` → `new AstroBuilder(...).run()`.
`AstroBuilder.setup()` runs `astro:config:setup`, creates the routes list, runs
`astro:config:done`. The Vite build itself is `viteBuild` (`src/core/build/static-build.ts`),
which — this matters for us — uses the **Vite Environment API builder**:

```ts
// static-build.ts:321-322
const builder = await vite.createBuilder(updatedViteBuildConfig);
await builder.buildApp();
```

with a custom `builder.buildApp` orchestrator (`static-build.ts:241-311`) that builds environments
in order: **`prerender` → `ssr` (only if `needsServerBuild`) → `client`** (client inputs are
discovered during the prerender/SSR builds). Astro 7 runs on **Vite 8 / rolldown-vite**
(`packages/astro/package.json` dependency `vite: ^8.0.13`) — the same major our
`cloudflare-vite-plugin` supports (`peerDependencies.vite: "^7.0.0 || ^8.0.0"`).

Environment names: `ASTRO_VITE_ENVIRONMENT_NAMES = { ssr: 'ssr', client: 'client', astro: 'astro', prerender: 'prerender' }`
(`src/core/constants.ts:101-112`; `astro` is a dev-only node-runnable helper environment used when
`ssr` is not runnable — i.e. exactly when a workerd plugin owns `ssr`).

Output directories (`src/prerender/utils.ts:12-38` + defaults in
`src/core/config/schemas/base.ts:66-84`): `outDir` = `./dist`, `build.client` = `dist/client/`,
`build.server` = `dist/server/`, `build.serverEntry` = `entry.mjs`. The prerender environment
builds to `dist/server/.prerender/` (`getPrerenderOutputDirectory`).

There is no build-result return value; results are files on disk (plus whatever plugins collect —
see §C).

### A.5 `sync(inlineConfig)` and `preview(inlineConfig)`

- `sync` generates `.astro/` types and content-collection modules; useful before type-checking a
  fixture, not needed for dev/build (both run it internally — `container.ts:123-134`,
  `AstroBuilder` `sync` option `src/core/build/index.ts:96-100`).
- `preview` requires the adapter to declare a `previewEntrypoint`
  (`src/core/preview/index.ts:66-79` — it `require.resolve`s and imports it). The Cloudflare
  adapter's preview entry hard-depends on a prior build's `.wrangler/deploy/config.json`
  (§B.5). We will not use `preview` — our runtime replaces it.

### A.6 Config injection

`AstroInlineConfig` = `AstroUserConfig & AstroInlineOnlyConfig`
(`src/types/public/config.ts:3340`). Relevant knobs:

- `configFile: false` — fully in-memory config, no `astro.config.*` needed (or leave undefined to
  merge a user config file with inline overrides; **inline takes highest priority**, see the
  JSDoc at `config.ts:3342-3350`).
- `root`, `outDir`, `server.port`, `server.host`.
- `adapter?: AstroIntegration` (`config.ts:361`), `integrations` (`config.ts:382`),
  `vite?: ViteUserConfig` (`config.ts:576`) — so we can inject the (forked) Cloudflare adapter
  **and** extra Vite plugins (e.g. a build-output collector) entirely programmatically.
- `logLevel`, or `logger: { entrypoint }` for a custom logger implementation
  (see `src/cli/flags.ts:40-44`, `astro/logger/*` export map entries).

**Verdict: no CLI spawn required for dev, build, or sync.**

---

## B. Cloudflare integration (`packages/integrations/cloudflare`, npm `@astrojs/cloudflare` v14.1.3)

### B.1 Architecture

`src/index.ts:129-136` default-exports `createIntegration(options): AstroIntegration`. Dependencies
(`packages/integrations/cloudflare/package.json`): `@cloudflare/vite-plugin: ^1.39.0` (regular
dep), `wrangler: ^4.83.0` (**peer** dep), `vite: ^8.0.13`. The adapter's `Options`
(`src/index.ts:85-127`) is mostly a passthrough of the CF plugin's `PluginConfig`:

```ts
export interface Options extends Pick<PluginConfig,
	'auxiliaryWorkers' | 'configPath' | 'inspectorPort' | 'persistState' | 'remoteBindings'> {
	imageService?: ImageServiceConfig;           // default 'cloudflare-binding' (utils/image-config.ts:19-36)
	sessionKVBindingName?: string;               // default 'SESSION'
	imagesBindingName?: string;                  // default 'IMAGES'
	prerenderEnvironment?: 'workerd' | 'node';   // default 'workerd'
	experimental?: Pick<..., 'headersAndRedirectsDevModeSupport'>;
}
```

Hook-by-hook:

- **`astro:config:setup`** (`src/index.ts:152`): builds `cfPluginConfig` with an in-memory
  **config customizer** (`src/index.ts:197`, from `cloudflareConfigCustomizer`,
  `src/wrangler.ts:27-76`) and instantiates the official plugin:

  ```ts
  // src/index.ts:263-266
  const cloudflareVitePlugins = cfVitePlugin({
  	...cfPluginConfig,
  	viteEnvironment: { name: 'ssr' },
  	assetsOnly: () => _buildOutput === 'static',
  });
  ```

  then `updateConfig({ vite: { plugins: [...] }, session, image, build: { redirects: false } })`
  with several companion plugins: `@astrojs/cloudflare:cf-imports` (externalizes `cloudflare:*`
  ids, `src/index.ts:337-347` in dist ordering), `@astrojs/cloudflare:environment` (huge
  `optimizeDeps.include` list for the workerd-resolved server environments `astro`/`ssr`/
  `prerender`), `@astrojs/cloudflare:cf-externals` (clears `ssr.external`),
  `createConfigPlugin(...)` (`src/vite-plugin-config.ts` — serializes adapter settings into the
  virtual module **`virtual:astro-cloudflare:config`** consumed by the runtime handler), and a
  prism workaround plugin. During `build`/`sync` it strips the CF plugin's dev server:
  `plugin.configureServer = undefined` (`src/index.ts:272-274`, gated by `isTypeGenPhase`,
  `src/index.ts:192`).
- **`astro:config:done`** (`src/index.ts:436`): `setAdapter({ name: '@astrojs/cloudflare',
  adapterFeatures: { buildOutput, middlewareMode: 'classic', preserveBuildClientDir: true,
  preserveBuildServerDir: true }, entrypointResolution: 'auto',
  previewEntrypoint: '@astrojs/cloudflare/entrypoints/preview', ... })` (`src/index.ts:463-491`);
  then `loadWranglerEnv(config.root, cloudflareOptions.configPath, logger)` (`src/index.ts:492`).
  Note `setAdapter` passes **no `serverEntrypoint`** — the worker entry comes from the wrangler
  `main` field instead (§B.3).
- **`astro:build:start`** (`src/index.ts:494-511`): when `prerenderEnvironment === 'workerd'`,
  `setPrerenderer(createCloudflarePrerenderer(...))` (§B.4).
- **`astro:build:setup`** (`src/index.ts:512-536`): for the server target sets
  `vite.ssr.noExternal = true`, `rolldownOptions.external = ['sharp']`, output banner
  `globalThis.process ??= {}; globalThis.process.env ??= {};`, and `define`s
  `globalThis.__ASTRO_IMAGES_BINDING_NAME`.
- **`astro:build:done`** (`src/index.ts:537+`): moves `.assetsignore`/`_headers`/`_redirects` for
  non-root `base`, **patches the generated build-output `wrangler.json` in
  `dist/server/`** (`src/index.ts:556-570` — rewrites `assets.directory` to point at the real
  client dir), injects immutable `Cache-Control` rules into `_headers`, and appends
  Astro-route redirects to `_redirects` (via `@astrojs/underscore-redirects`).

### B.2 Runtime entry and bindings/env access

Worker entry module `@astrojs/cloudflare/entrypoints/server` (`src/entrypoints/server.ts`, 7
lines): `export default { fetch: handle }` with `handle` from `src/utils/handler.ts`:

```ts
// src/utils/handler.ts:1,8,9,33,42
import { env as globalEnv } from 'cloudflare:workers';
import { createApp } from 'astro/app/entrypoint';
import { setGetEnv } from 'astro/env/setup';
setGetEnv(createGetEnv(globalEnv));   // astro:env reads from cloudflare:workers env
const app = createApp();
```

- Bindings are read off the `fetch(request, env, context)` `env` object: `env.ASSETS.fetch(...)`
  for static assets (`src/utils/cf-helpers.ts:29,42,56`), `env[sessionKVBindingName]` injected
  into the session config at request time (`src/utils/cf.ts` `injectSessionBinding`).
- `Astro.locals.cfContext` carries the execution context; the legacy
  `Astro.locals.runtime.{env,cf,caches,ctx}` getters now **throw** with migration messages
  (`src/utils/cf-helpers.ts:66-95`) — the blessed pattern is `import { env } from 'cloudflare:workers'`.
- `astro/app/entrypoint` resolves through the virtual module `virtual:astro:app`
  (`packages/astro/src/core/app/entrypoints/virtual/index.ts`), which
  `packages/astro/src/vite-plugin-app/index.ts:27-31` maps to `astro/app/entrypoint/dev`
  (a `DevApp` with HMR route/middleware invalidation — `virtual/dev.ts`) under `vite serve` and
  `astro/app/entrypoint/prod` under build. **The same worker entry file serves dev and prod.**

### B.3 What a production build emits

Because the adapter rides `@cloudflare/vite-plugin`, the deploy layout is the plugin's
Workers-Assets layout, not the old Pages `_worker.js` one (evidence from
`@cloudflare/vite-plugin@1.40.2` dist, `dist/index.mjs`, `outputConfigPlugin` at lines
56419-56487 and `writeDeployConfig` at 37312-37319; entry input name `MAIN_ENTRY_NAME = "index"`
at 51271):

```
dist/
  client/                 # vite client environment output (astro build.client default)
    _astro/*              # hashed assets
    _headers, _redirects  # written/augmented by astro:build:done
    .assetsignore         # emitted by the CF plugin ("wrangler.json\n.dev.vars")
    <prerendered .html>   # written by astro's generation phase after the vite build
  server/                 # vite ssr environment output (astro build.server default)
    entry.mjs             # entry chunk (input name "index"; filename = astro build.serverEntry,
                          #   see packages/astro/src/core/build/vite-build-config.ts:113-131)
    chunks/*.mjs          # shared chunks
    wrangler.json         # GENERATED output config: { ...inputConfig, main: <entry fileName>,
                          #   no_bundle: true, rules: [{type:"ESModule",...}],
                          #   assets: { directory: "../client", binding: "ASSETS", ... } }
    .prerender/           # prerender-environment build (build-time only, not deployed)
.wrangler/deploy/config.json   # redirect file pointing wrangler at dist/server/wrangler.json
```

The input wrangler config is whatever the user's `wrangler.{toml,json,jsonc}` contains — **or pure
defaults** — merged through the adapter's customizer (`src/wrangler.ts:27-76`):
`main ?? '@astrojs/cloudflare/entrypoints/server'`, `compatibility_date ?? '2026-04-15'`,
`assets.binding ?? 'ASSETS'`, auto-added `kv_namespaces: [{ binding: 'SESSION' }]` (provisioned on
deploy) and `images: { binding: 'IMAGES' }` unless already present. For fully-static builds
(`assetsOnly`) the plugin instead writes an assets-only `wrangler.json` into `dist/client/`.

### B.4 Dev-mode emulation and workerd prerendering

- **Dev:** `@cloudflare/vite-plugin`'s `devPlugin.configureServer` (plugin dist
  `index.mjs:56196-56260`) starts an embedded **Miniflare** instance
  (`startOrUpdateMiniflare`, dist 37077-37081; **no `getPlatformProxy` anywhere** in v1.40),
  replaces the `ssr` Vite environment with a fetchable (non-runnable) environment backed by a
  module runner *inside workerd*, and installs middleware dispatching requests to the entry
  worker via `miniflare.dispatchFetch`. Astro cooperates automatically: its dev-server plugin
  only installs the node-side SSR handler when the `ssr` environment `isRunnableDevEnvironment`
  (`packages/astro/src/vite-plugin-astro-server/plugin.ts:46-72`), and it keeps a separate
  node-runnable `astro` environment for its own tooling (content layer, sync)
  (`src/core/create-vite.ts:288-293`, comment at `src/core/constants.ts:106-111`).
- **Prerendering (`prerenderEnvironment: 'workerd'`, the default):**
  `createCloudflarePrerenderer` (`src/prerenderer.ts`, dist `prerenderer.js:11-144`) boots
  `vite.preview()` over `dist/server` with `cfVitePlugin({ ...cfPluginConfig, viteEnvironment: { name: 'prerender' } })`
  and drives it over HTTP: POST `__astro_*` endpoints (`STATIC_PATHS_ENDPOINT`,
  `PRERENDER_ENDPOINT`, `STATIC_IMAGES_ENDPOINT`) that the worker handler answers when built with
  `isPrerender` (`src/utils/handler.ts:44-58`). The plugin side is the CF plugin's
  `experimental.prerenderWorker` (`src/index.ts:205-224`; plugin type
  `PrerenderWorkerConfig`, plugin dist `index.d.mts:96-101,116`).
  With **`prerenderEnvironment: 'node'`** the adapter instead installs
  `createNodePrerenderPlugin()` in dev (`src/index.ts:333` area,
  `src/vite-plugin-dev-server-prerender-middleware.ts`) and never calls `setPrerenderer`, so
  Astro's default node prerenderer runs — no workerd involvement in prerendering at all.

### B.5 Exhaustive wrangler / wrangler.json coupling inventory

| # | Touchpoint | Where | Nature |
|---|---|---|---|
| 1 | `@cloudflare/vite-plugin` dependency | `packages/integrations/cloudflare/package.json` | The whole dev/build CF machinery. The plugin itself hard-imports the `wrangler` package (`import * as wrangler from "wrangler"`, plugin dist `index.mjs:4`) for `unstable_readConfig` (37309, 44014), `unstable_defaultWranglerConfig` (44209), `unstable_getWorkerNameFromProject` (44229), and depends on `miniflare` |
| 2 | `wrangler` peer dep `^4.83.0` | `packages/integrations/cloudflare/package.json` | required at install time |
| 3 | `loadWranglerEnv` | `src/utils/wrangler-config.ts:4` — `import { unstable_getVarsForDev, unstable_readConfig } from 'wrangler'`; called at `astro:config:done` (`src/index.ts:492`) | reads `wrangler.{toml,json,jsonc}` + `.dev.vars` and copies `vars` into `process.env` so `astro:env` sees them at build time. Fails soft (warn) if unreadable |
| 4 | Config-file watchers | `src/index.ts:429-431` — `addWatchFile(wrangler.toml/json/jsonc)` | dev-server restart trigger only |
| 5 | Wrangler-config *file* resolution | plugin dist `index.mjs:44168-44178` (`findWranglerConfig`) | **optional** — falls back to `unstable_defaultWranglerConfig` + the adapter's in-memory customizer (`resolveWorkerConfig`, dist 44201-44236). A wrangler.json file is NOT required to build or dev |
| 6 | Build output `wrangler.json` | plugin `outputConfigPlugin` (dist 56419-56487) + adapter patch (`src/index.ts:556-570`) | *produced*, not consumed, by the toolchain; consumed by `wrangler deploy` |
| 7 | `.wrangler/deploy/config.json` | plugin `writeDeployConfig` (dist 37312) ; required by the adapter preview entry (`src/entrypoints/preview.ts`, dist `preview.js:22-27`) | preview/deploy only |
| 8 | `CLOUDFLARE_ENV` / `CLOUDFLARE_*` env prefixes | `src/utils/wrangler-config.ts:24-31`, plugin dist 44252-44254 | env-selection convention |

Nothing else in the adapter touches wrangler. Critically, the **runtime code**
(`src/entrypoints/server.ts`, `src/utils/handler.ts`, `src/utils/cf.ts`, `src/utils/cf-helpers.ts`,
`src/utils/env.ts`, `src/utils/prerender.ts`) and the **config-shape code** (`src/wrangler.ts`
customizer, `src/vite-plugin-config.ts` virtual module) import **no wrangler API at all**.

---

## C. Adaptation plan for cloudflare-tools + alchemy

Goal: an Effect `Context.Service` shaped like `packages/tools/e2e/src/Vite.ts` —
`Astro.build(...) → BuildOutput { clientDirectory, serverModules (entry first), externalWorkspaces }`
and `Astro.dev(...) → { url, stop }` running against **our** `cloudflare-runtime`, with **zero
wrangler dependency and no wrangler.json**.

### C.1 Why this is a good fit

Astro 7 + adapter v14 is architecturally the *closest* upstream to our stack of any framework
surveyed: Vite 8 Environment API, a single `ssr` environment as the worker
(`viteEnvironment: { name: 'ssr' }`, `src/index.ts:265`) — exactly our plugin's default
(`parseViteEnvironments`, `packages/cloudflare-rolldown-plugin/src/options.ts:50`), dev SSR inside
workerd via module runner, and a non-runnable ssr dev environment that Astro core already knows how
to step around (`vite-plugin-astro-server/plugin.ts:46-51` — our `DistilledDevEnvironment extends
vite.DevEnvironment`, `packages/cloudflare-vite-plugin/src/dev-environment.ts:7`, is equally
non-runnable, so Astro will behave identically).

### C.2 Strategy: fork the integration, keep the runtime, drive via inline config

**Do not** try to run plain `astro build` through our vite plugin without an adapter — Astro
requires an adapter for server output (`AstroBuilder.setup` validation) and the adapter contributes
essential build config (noExternal, banner, virtual config module). Instead:

1. **Fork `createIntegration`** (`packages/integrations/cloudflare/src/index.ts`, ~530 lines) into
   a `@distilled.cloud/astro` (or `tools/e2e/src/Astro.ts` first). Line-item disposition:
   - `cfVitePlugin({...})` (`index.ts:263-266`) → `cloudflareVitePlugin({ main:
     '@astrojs/cloudflare/entrypoints/server', viteEnvironments: { entry: 'ssr' },
     compatibilityDate, compatibilityFlags: ['nodejs_compat'], worker: { bindings... },
     context })` (our `packages/cloudflare-vite-plugin/src/plugin.ts:21-49`). Our plugin reads
     `main` from options — no wrangler config resolution step exists to replace.
   - `cloudflareConfigCustomizer` (`src/wrangler.ts`) → dissolves: its outputs (`main`,
     `compatibility_date`, `assets`/`SESSION`/`IMAGES` bindings) become plain fields on our
     plugin's `worker`/options, generated in-memory by the alchemy layer (this *is* our
     "config surface instead of wrangler.json", see C.4).
   - `loadWranglerEnv` (`index.ts:492`) → drop. astro:env build-time vars come from
     `process.env`/`vite.define`, which alchemy controls directly.
   - wrangler config watchers (`index.ts:429-431`) → drop.
   - `createCloudflarePrerenderer` + `experimental.prerenderWorker` (`index.ts:205-224,494-511`)
     → phase 1: hardwire the adapter's own `prerenderEnvironment: 'node'` path (keep
     `createNodePrerenderPlugin`, skip `setPrerenderer`) so prerendering uses Astro's stock node
     pipeline. Phase 2 (optional fidelity): reimplement the prerender loop over
     `cloudflare-runtime` — the HTTP protocol is tiny and fully specified in
     `src/prerender-types.ts` + `src/utils/prerender-constants.ts`.
   - `previewEntrypoint` (`index.ts:472`) → drop; our runtime serves the build output.
   - Keep verbatim: the `optimizeDeps.include` environment plugin (`index.ts:277-336` region —
     our plugin also runs a dep optimizer, `dev-plugin.ts:96`), `cf-imports` externalization
     (ours also externalizes `cloudflare:*` via `cloudflareExternalsPlugin`— dedupe), `cf-externals`,
     `createConfigPlugin` (`vite-plugin-config.ts` — pure, powers
     `virtual:astro-cloudflare:config`), `astro:build:setup` tweaks, session/image
     `updateConfig` logic, and the `_headers`/`_redirects` post-processing in `astro:build:done`
     (minus the output-wrangler.json patch, which becomes moot).
2. **Reuse the published runtime modules as-is** by depending on `@astrojs/cloudflare` *only* for
   its wrangler-free entrypoints (`@astrojs/cloudflare/entrypoints/server`, `/handler`) — the
   package's `exports` map exposes them directly — or vendor the five small files. Either way no
   wrangler code is pulled into the worker bundle (verified: zero wrangler imports in those files).
3. **Wrap in an Effect service** (`Astro.ts`), mirroring `Vite.ts`:
   - `build`: call astro's `build({ root, configFile, adapter: distilledCloudflare(opts),
     vite: { plugins: [outputCollector] }, logLevel: 'error' })`. The collector is Vite.ts's
     `output()` plugin (`Vite.ts:122-179`) injected through `AstroInlineConfig.vite.plugins`
     (merged into every environment; keep `sharedDuringBuild: true`). Set
     `serverEntryEnvironment = 'ssr'` and **skip the `prerender` environment** in `writeBundle`
     (build-time-only output under `dist/server/.prerender/`) — a two-line filter on
     `this.environment.name`. `clientDirectory` comes from the `client` environment as today;
     note Astro writes prerendered HTML into that directory *after* the Vite build, so directory
     consumers see them but in-memory `serverModules` snapshots correctly don't.
   - `dev`: `Effect.acquireRelease(dev(inlineConfig), (s) => Effect.promise(() => s.stop()))`;
     URL from `resolvedUrls.local[0]` (same shape as Vite.ts) or `address`.
4. **Alchemy wiring**: `BuildOutput.serverModules` (entry first — the ssr entry chunk, filename
   `entry.mjs`) uploads as the worker; `clientDirectory` becomes the assets upload; bindings
   (ASSETS, optional SESSION KV, optional IMAGES) are declared on the alchemy Worker resource —
   the same data the wrangler.json would have carried, now flowing through alchemy's binding
   system.

### C.3 Reuse / fork / build matrix

| Piece | Disposition |
|---|---|
| `astro` `dev()`/`build()`/`sync()` | reuse as-is (public API) |
| adapter runtime (`entrypoints/server`, `utils/handler|cf|cf-helpers|env|prerender`) | reuse as-is (import from `@astrojs/cloudflare` exports or vendor) |
| adapter `vite-plugin-config.ts`, image-config, headers/redirects post-processing | reuse (copy) |
| adapter integration hooks (`index.ts`) | **fork** (~530 lines, mostly deletions) |
| `@cloudflare/vite-plugin` | **replace** with `@distilled.cloud/cloudflare-vite-plugin` |
| `loadWranglerEnv`, preview entrypoint, workerd prerenderer | drop (phase 1) |
| output collector + Effect service | new, ~150 lines, largely copied from `Vite.ts` |

### C.4 Config we generate in-memory (the wrangler.json replacement)

`{ name, main: '@astrojs/cloudflare/entrypoints/server', compatibility_date: '2026-04-15',
compatibility_flags: ['nodejs_compat'], assets: { binding: 'ASSETS', directory: <client> },
kv_namespaces: [{ binding: 'SESSION' }]?, images: { binding: 'IMAGES' }? }` — i.e. exactly what
`cloudflareConfigCustomizer` (`src/wrangler.ts:27-76`) synthesizes today, expressed as our plugin
options + alchemy Worker props instead of a wrangler.json.

### C.5 Risks & unknowns

1. **Dev `ASSETS` binding**: `handler.ts` unconditionally reaches `env.ASSETS` on 404 fallback
   (`utils/cf-helpers.ts:42`). Upstream miniflare wires ASSETS to a vite-proxying asset worker in
   dev; our runtime's `assets` plugin (`cloudflare-runtime/src/bindings/assets/`) must be able to
   proxy to the vite client dev server (or we shim a fetcher returning 404s in dev). Needs a spike.
2. **Local KV for sessions**: adapter enables a KV-backed session driver by default
   (`index.ts:102-113`); our runtime's `KvNamespace` binding is **remote-only** today
   (`cloudflare-runtime/src/bindings/KvNamespace.ts`). Mitigate: disable sessions in fixtures /
   default `session.driver` off in the fork, or implement the local KV plugin (miniflare parity
   work already templated in AGENTS.md).
3. **Images binding**: default `imageService: 'cloudflare-binding'` needs an `IMAGES` binding
   (remote-only in our runtime, `bindings/Images.ts`). Mitigate: default the fork to
   `imageService: 'compile'` or `'passthrough'`.
4. **Node prerender divergence** (phase 1): prerendered pages execute under node, not workerd —
   pages importing `cloudflare:workers` at prerender time would fail. The adapter itself ships
   this mode (`prerenderEnvironment: 'node'`), so it's an accepted upstream configuration, but
   note it as a fidelity gap until phase 2.
5. **Dep-optimizer parity**: the adapter's giant `optimizeDeps.include` list (`index.ts:280-330`
   region) is tuned for the CF plugin's workerd resolver; our optimizer may need additions
   (esp. `astro/app/entrypoint/dev` and the `astro > *` nested specifiers).
6. **Middleware ordering in dev**: our catch-all proxy middleware
   (`cloudflare-vite-plugin/src/dev-plugin.ts:107-120`) must not shadow Astro's dev-toolbar/HMR
   endpoints; upstream uses a pre-middleware with static-routing matchers (plugin dist
   56240-56258). Likely fine (ours registers post-internal-middlewares) but must be verified
   against `/@vite/*`, `/@id/*` and the `astro` environment's requests.
7. **Astro pins `viteEnvironment.name: 'ssr'`**, matching our default — but Astro also creates the
   dev-only runnable `astro` environment; our plugin must leave non-listed environments alone
   (it does — it only maps configured names, `dev-plugin.ts:33-51`).
8. **API stability**: astro's JS API is marked `@experimental`; the adapter internals
   (virtual module names, prerender endpoints) are private and versioned with astro majors. Pin
   versions; the fork tracks the 14.x line.
9. **`vite.createBuilder` is invoked by astro, not us** — builder-level options we'd normally set
   in `Vite.ts` must arrive via `AstroInlineConfig.vite`, and anything astro overrides
   (`static-build.ts` forces `minify: false`, custom `buildApp`) is out of our control.

### C.6 Effort

**Medium.** The service wrapper is near-mechanical (Vite.ts clone + inline-config plumbing); the
integration fork is mostly deletion; the real work is the two runtime-binding gaps (dev ASSETS
proxy, local KV) and dev-loop verification.
