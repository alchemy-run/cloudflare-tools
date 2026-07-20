# Waku — programmatic integration design spec

Research target: **Waku** (minimal React Server Components framework), submodule at
`upstream/waku` (HEAD `f092454`, package `waku@1.0.0-beta.7`, Vite `^8.0.0`, built on
`@vitejs/plugin-rsc ^0.5.28`). All paths below are relative to the submodule root unless
prefixed with `cloudflare-tools/`.

Goal: an Effect `Context.Service` exposing `{ build, dev }` shaped like
`cloudflare-tools/packages/tools/e2e/src/Vite.ts` (`Vite` service, `ViteLive` layer,
`BuildOutput = { clientDirectory, serverModules (entry first), externalWorkspaces }`),
running dev against our `@distilled.cloud/cloudflare-runtime` (workerd) via
`@distilled.cloud/cloudflare-vite-plugin`, with **no wrangler and no wrangler.json**.

---

## TL;DR

- Waku's CLI (`packages/waku/src/cli.ts`) is a ~80-line arg parser. `waku dev` and
  `waku build` are thin wrappers over **`vite.createServer`** / **`vite.createBuilder`**
  with a single composite plugin, `combinedPlugins(config)` — the exact shape our
  `Vite.ts` exemplar already drives. `combinedPlugins` is publicly exported as
  **`unstable_combinedPlugins`** from `waku/vite-plugins`, and config resolution as
  **`unstable_resolveConfig`** from `waku/internals`.
- Cloudflare support is a **server-entry adapter** (`waku/adapters/cloudflare`,
  source `packages/waku/src/adapters/cloudflare.ts`) that runs entirely inside the
  worker bundle (Hono app + `cloudflare:workers` env access) plus a Node-side
  **build enhancer** (`packages/waku/src/adapters/cloudflare-build-enhancer.ts`) that
  writes fallback `wrangler.jsonc` / `dist/server/wrangler.json` files. The enhancer is
  the *only* wrangler-config touchpoint in the whole package, it is fallback-only
  ("if no wrangler config exists, write one"), and it is trivially neutralized.
- Waku itself **never imports wrangler, never spawns wrangler, and has no dependency on
  `@cloudflare/vite-plugin`** — dev-mode workerd emulation is achieved by the *user*
  adding `@cloudflare/vite-plugin` to `waku.config.ts` `vite.plugins` with
  `viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] }`. Our
  `@distilled.cloud/cloudflare-vite-plugin` supports the identical topology via
  `viteEnvironments: { entry: "rsc", children: ["ssr"] }`
  (`cloudflare-tools/packages/cloudflare-rolldown-plugin/src/options.ts:43-47`), already
  exercised by the `fixtures/react-router-rsc` fixture. Waku is therefore the
  **best-aligned framework surveyed**: adaptation is mostly configuration, not forking.
- Two real gotchas: (1) the SSG step of `waku build` depends on a global
  (`globalThis.__WAKU_START_PREVIEW_SERVER__`) that only the CLI's `runBuild` sets — our
  programmatic driver must set it too; (2) Waku's `rsc` environment declares **two**
  rolldown inputs (`index` + `build`) while our dev plugin asserts exactly one entry —
  we must pass `main` explicitly so our plugin's own input wins in dev, and make sure the
  `build` input survives for the SSG runner in build.

---

## A. Programmatic hooks

### A.1 CLI entry → programmatic layer

`packages/waku/src/cli.ts` parses `dev|build|start|router` plus `--host/--port` and
dynamically imports one command module each (`cli.ts:37-50`):

```ts
} else if (cmd === 'dev') {
  const { runDev } = await import('./lib/vite-rsc/cmd-dev.js');
  await runDev(values);
} else if (cmd === 'build') {
  const { runBuild } = await import('./lib/vite-rsc/cmd-build.js');
  await runBuild();
```

There is **no CLI-only logic** beyond dotenv loading and arg parsing. The command
modules are pure library code.

### A.2 Dev — `runDev` (`packages/waku/src/lib/vite-rsc/cmd-dev.ts`)

`runDev` (`cmd-dev.ts:81-88`) does:

1. `process.env.NODE_ENV ??= 'development'` (required *before* `vite.runnerImport`, see
   comment referencing vitejs/vite#20299 at `cmd-dev.ts:82-83`).
2. `loadConfig()` (`lib/vite-rsc/loader.ts:11-20`): if `waku.config.ts|js` exists,
   imports it via `vite.runnerImport('/waku.config')`, then `resolveConfig(config)`.
3. `startDevServer` (`cmd-dev.ts:37-79`):

```ts
const server = await vite.createServer({
  configFile: false,
  plugins: [combinedPlugins(config)],
  server: host ? { host, port } : { port },
});
...
await server.listen();
const url = server.resolvedUrls?.network?.[0] ?? server.resolvedUrls?.local?.[0];
```

Extras the CLI adds that a programmatic driver may skip: a `server.restart` override and
chokidar watchers that restart the whole server when `waku.config.ts` changes
(`cmd-dev.ts:51-76`), and `loadDotEnv()` (`loader.ts:7-9`, `dotenv.config({ path:
['.env.local', '.env'] })`).

**Port/URL exposure and shutdown are stock Vite**: `server.resolvedUrls`,
`server.close()` — identical to what `Vite.ts` already does (`Vite.ts:255-279`
`acquireRelease` + `resolvedUrls.local[0]`).

### A.3 Build — `runBuild` (`packages/waku/src/lib/vite-rsc/cmd-build.ts`)

`cmd-build.ts:9-20`:

```ts
export async function runBuild() {
  process.env.NODE_ENV ??= 'production';
  const config = await loadConfig();
  const builder = await vite.createBuilder({
    configFile: false,
    plugins: [combinedPlugins(config)],
  });
  globalThis.__WAKU_START_PREVIEW_SERVER__ = () => startPreviewServerImpl(config);
  await builder.buildApp();
}
```

`startPreviewServerImpl` (`cmd-build.ts:22-36`) wraps `vite.preview({ configFile: false,
plugins: [combinedPlugins(config)] })` and returns `{ baseUrl, middlewares, close }`
(type `PreviewServer`, `lib/vite-rsc/preview.ts:13-17`).

**Critical**: `startPreviewServer()` (`lib/vite-rsc/preview.ts:19-25`) throws
`'Preview server is not available.'` unless `globalThis.__WAKU_START_PREVIEW_SERVER__`
is set. The Cloudflare adapter's SSG build step calls it (see B.4). Any programmatic
driver that calls `builder.buildApp()` itself **must set this global first**.

### A.4 Public programmatic API surface (stability)

The command modules (`lib/vite-rsc/cmd-*.js`) are **not** in the package `exports` map
(`packages/waku/package.json` — exports are `.`, `./config`, `./client`, `./server`,
`./adapter-builders`, `./internals`, `./vite-plugins`, `./adapters/*`, `./minimal/*`,
`./router*` only). So deep-importing `runDev`/`runBuild` is an internal-path import.

However, everything they compose IS exported, with the `unstable_` prefix
(semver-minor churn expected, but public):

- `packages/waku/src/vite-plugins.ts:5` —
  `export { combinedPlugins as unstable_combinedPlugins } from './lib/vite-plugins/combined-plugins.js'`
  (plus each individual plugin: `unstable_environmentsPlugin`,
  `unstable_appEntriesPlugin`, `unstable_adapterAliasPlugin`,
  `unstable_staticBuildPlugin`, `unstable_virtualConfigPlugin`, …).
- `packages/waku/src/internals.ts:3` —
  `export { resolveConfig as unstable_resolveConfig } from './lib/utils/config.js'`
  (also `unstable_constants`, `unstable_honoMiddleware`,
  `unstable_produceMultiplexedStream`, `unstable_consumeMultiplexedStream`).
- `packages/waku/src/adapter-builders.ts` —
  `unstable_createServerEntryAdapter` (from `lib/vite-rsc/handler.ts`),
  `unstable_startPreviewServer` (from `lib/vite-rsc/preview.ts`).

So the canonical programmatic invocation, replicating the CLI exactly with zero
internal-path imports:

```ts
import * as vite from "vite";
import { unstable_combinedPlugins as combinedPlugins } from "waku/vite-plugins";
import { unstable_resolveConfig as resolveConfig } from "waku/internals";

const config = resolveConfig(userWakuConfig /* or undefined */);

// dev
const server = await vite.createServer({
  configFile: false,
  plugins: [combinedPlugins(config)],
  server: { port },
});
await server.listen();

// build
const builder = await vite.createBuilder({
  configFile: false,
  plugins: [combinedPlugins(config)],
});
globalThis.__WAKU_START_PREVIEW_SERVER__ = async () => {
  const preview = await vite.preview({ configFile: false, plugins: [combinedPlugins(config)] });
  return { baseUrl: preview.resolvedUrls!.local[0]!, middlewares: { use: (fn) => preview.middlewares.use(fn) }, close: () => preview.close() };
};
await builder.buildApp();
```

**Verdict: fully programmatic, no CLI spawn needed.** Config injection: the `Config`
type (`packages/waku/src/config.ts:12-51`) carries `basePath`, `srcDir`, `distDir`,
`privateDir`, `rscBase`, `unstable_adapter` (adapter module id), and `vite?: UserConfig`
(merged into Waku's own vite config by `environmentsPlugin`, `environments.ts:90-95`;
`config.vite.plugins` are injected separately via `extraPlugins`, and any user plugin
whose `name` collides with a Waku plugin *replaces* it —
`combined-plugins.ts:30-39 excludeOverriddenPlugins`). We can inject everything
in-memory; no `waku.config.ts` file is required.

### A.5 What `combinedPlugins` assembles

`packages/waku/src/lib/vite-plugins/combined-plugins.ts:41-68` — order matters:

1. `extraPlugins(config)` (`extra-plugins.ts:5-16`) — user's `config.vite.plugins`,
   auto-appending `@vitejs/plugin-react` if absent.
2. `allowServerPlugin()`, then **`rsc({ serverHandler: false, keepUseCientProxy: true,
   useBuildAppHook: true, clientChunks: ... })`** — `@vitejs/plugin-rsc`, which defines
   the `rsc`/`ssr`/`client` environment machinery and (via `useBuildAppHook`) the
   multi-environment build orchestration inside `builder.buildApp()`.
3. `environmentsPlugin(config)` (`environments.ts:17-159`) — defines env inputs/outDirs
   (see B.2) and the Node dev request bridge (see B.5).
4. `appEntriesPlugin` (`app-entries.ts`) — resolves
   `virtual:vite-rsc-waku/server-entry` → `/{srcDir}/waku.server` (user file,
   constant `SRC_SERVER_ENTRY = 'waku.server'`, `lib/constants.ts`) or generates a
   "managed mode" entry (`lib/utils/managed.ts:getManagedServerEntry`) that does
   `import adapter from 'waku/adapters/default'` + `fsRouter(import.meta.glob(...))`.
5. `virtualConfigPlugin` (`virtual-config.ts`) — serializes the resolved config into
   `virtual:vite-rsc-waku/config` (`config`, `isBuild`).
6. `adapterAliasPlugin(config)` (`adapter-alias.ts:3-27`) — rewrites imports of
   `'waku/adapters/default'` to `config.unstable_adapter`.
7. `staticBuildPlugin(config)` (`static-build.ts`) — the SSG `buildApp` hook (B.4).
8. plus `buildIdPlugin`, `buildMetadataPlugin`, `notFoundPlugin`, `patchRsdwPlugin`,
   `privateDirPlugin`, `htmlShellPlugin`, `fsRouterTypegenPlugin`, `rscDevtoolsPlugin`.

Adapter default selection (`lib/utils/config.ts:3-10`): env-driven —
`process.env.CLOUDFLARE || process.env.WORKERS_CI` → `'waku/adapters/cloudflare'`,
else Vercel/Netlify env vars, else `'waku/adapters/node'`. Explicit
`unstable_adapter: 'waku/adapters/cloudflare'` in config overrides. (The legacy
`DEPLOY_TARGET` / `--with-cloudflare` flags and `unstable_viteConfigs` from waku ≤0.21
**no longer exist** at this HEAD — `grep` finds neither.)

---

## B. Cloudflare integration

### B.1 The adapter model

A Waku "server entry" is what the user's `src/waku.server.tsx` default-exports:

```ts
import { fsRouter } from 'waku';
import adapter from 'waku/adapters/cloudflare';
export default adapter(fsRouter(import.meta.glob('./pages/**/*.{tsx,ts}')));
```

(e2e fixture `e2e/fixtures/cloudflare-adapter/src/waku.server.tsx`.)

`unstable_createServerEntryAdapter` (`lib/vite-rsc/handler.ts:176-193`) wires the
router's `handleRequest`/`handleBuild` into `processRequest`/`processBuild` (RSC
rendering via `@vitejs/plugin-rsc/rsc`; SSR env loaded with
`import.meta.viteRsc.loadModule('ssr', 'index')`, `handler.ts:31-37`) and passes them to
the adapter factory. The adapter returns an `Unstable_ServerEntry`
(`lib/types.ts:83-97`):

```ts
export type Unstable_ServerEntry = {
  fetch: (req: Request, ...args: any[]) => Response | Promise<Response>;
  build: (utils: { emitFile; unstable_registerPrunableFile }, ...args) => Promise<void>;
  buildOptions?: Record<string, unknown>;
  buildEnhancers?: string[]; // enhancer module ids
  defaultExport?: unknown;
};
```

### B.2 The cloudflare adapter (`packages/waku/src/adapters/cloudflare.ts`)

Runtime side (bundled into the worker):

- Builds a Hono app (`hono/tiny`) with `bodyLimit`, user `middlewareFns` /
  `middlewareModules`, `middlewareRunner` + `rscMiddleware` from
  `waku/internals` `unstable_honoMiddleware` (`cloudflare.ts:84-100`).
- `fetchFn` (`cloudflare.ts:117-153`): dynamically imports **`cloudflare:workers`**
  (guarded, `DO_NOT_BUNDLE` trick at `cloudflare.ts:126-131`) and, when present, calls
  `app.fetch(req, env, { waitUntil, passThroughOnException, props })`. Falls back to
  plain `app.fetch(req)` outside workerd. This is the **bindings/env access pattern**:
  runtime code (and user code, per `docs/guides/cloudflare.mdx:137`) uses
  `import { env, waitUntil } from 'cloudflare:workers'` — no wrangler proxy, no
  `getPlatformProxy`.
- `defaultExport` (`cloudflare.ts:189-195`): `{ ...options?.handlers, fetch(req, env) {
  setAllEnv(env); return fetchFn(req); } }` — a real `ExportedHandler`; `setAllEnv`
  (`lib/env.ts:7-15`) copies string env vars into
  `globalThis.__WAKU_SERVER_ENV__` for Waku's `getEnv`. `options.handlers` lets users
  add `queue`/`scheduled` handlers (`docs/guides/cloudflare.mdx:167-191`).
- The built worker module is `lib/vite-entries/entry.server.tsx`, whose default export
  is `serverEntry.defaultExport` (`entry.server.tsx:15`) — i.e. `dist/server/index.js`
  default-exports the `ExportedHandler` above.
- Adapter option `static: true` produces an assets-only deployment
  (`buildOptions.serverless = !options?.static`, `cloudflare.ts:101-106`).

### B.3 Environments and build output layout

`environmentsPlugin` (`environments.ts:45-88, 115-125`) defines three vite environments
with fixed inputs and outDirs:

| env      | rolldown input                                             | outDir              |
| -------- | ---------------------------------------------------------- | ------------------- |
| `client` | `waku/dist/lib/vite-entries/entry.browser.js` (name `index`) | `{distDir}/public`  |
| `ssr`    | `.../entry.ssr.js` (name `index`)                          | `{distDir}/server/ssr` |
| `rsc`    | `.../entry.server.js` (name `index`) **and** `.../entry.build.js` (name `build`) | `{distDir}/server` |

(`DIST_PUBLIC = 'public'`, `DIST_SERVER = 'server'`, `lib/constants.ts`.)

So `waku build` with the cloudflare adapter emits:

- `dist/public/**` — client assets (hashed chunks in `assets/`), SSG HTML files, RSC
  payload files under `dist/public/RSC/...` (emitted during SSG, see B.4), any
  `public/_headers` copied through.
- `dist/server/index.js` — **the worker entry** (ESM, default export =
  `ExportedHandler`), plus server chunks, `dist/server/ssr/index.js` (loaded at runtime
  by the RSC env via `import.meta.viteRsc`), and
  `dist/server/__waku_build_metadata.js` (`handler.ts:166-173`).
- No `_routes.json` (that's a Pages concept; Waku targets Workers + assets binding with
  `run_worker_first` semantics left default).
- With upstream `@cloudflare/vite-plugin` present, that plugin additionally emits its
  own `wrangler.json` into the output (acknowledged in
  `lib/utils/prune-build.ts:64-65`: "Standalone assets (e.g. `wrangler.json` from
  @cloudflare/vite-plugin) aren't ours to manage").

The reference deploy config (fixture `e2e/fixtures/cloudflare-adapter/wrangler.jsonc`):
`main: "./src/waku.server"`, `compatibility_flags: ["nodejs_als"]`,
`compatibility_date: "2025-11-17"`, `assets: { binding: "ASSETS", directory:
"./dist/public", html_handling: "drop-trailing-slash" }`, `rules: [{ type: "ESModule",
globs: ["**/*.js", "**/*.mjs"] }]`, `no_bundle: true`. Note `nodejs_als` (not full
`nodejs_compat`) is sufficient for Waku core (`docs/guides/cloudflare.mdx:114-122`).

### B.4 SSG build flow (where the preview-server global matters)

`builder.buildApp()` → `@vitejs/plugin-rsc`'s `useBuildAppHook` builds
rsc → ssr → client, then Waku's `staticBuildPlugin.buildApp`
(`static-build.ts:31-83`) runs:

1. Imports the freshly built `dist/server/build.js` (the `build` input of the rsc env)
   and calls `INTERNAL_runBuild({ rootDir, emitFile })`
   (`lib/vite-entries/entry.build.ts:27-52`).
2. `INTERNAL_runBuild` applies **buildEnhancers** by module id
   (`entry.build.ts:36-41`): for cloudflare,
   `buildEnhancers: ['waku/adapters/cloudflare-build-enhancer']`
   (`adapters/cloudflare.ts:188`), resolved via `createRequire` from the project root
   and composed around `serverEntry.build`.
3. The cloudflare adapter's `build` (`adapters/cloudflare.ts:157-186`) calls
   `startPreviewServer()` (**requires `globalThis.__WAKU_START_PREVIEW_SERVER__`**),
   registers a *fallback* middleware that streams the SSG output directly ("Fallback
   middleware for the case without @cloudflare/vite-plugin",
   `cloudflare.ts:159-169`), then fetches
   `{baseUrl}/__waku_internal_build_static_files` and demultiplexes the response into
   `emitFile` calls (static HTML / RSC payloads land in `dist/public`). The clever bit:
   if a Cloudflare vite plugin serves the preview, that internal route is answered *by
   the worker running under workerd* (`fetchFn` handles it at `cloudflare.ts:117-124`,
   gated by `isLoopbackRequest` && `!isProductionWorker`), so SSG rendering happens in
   the target runtime; otherwise the Node fallback middleware answers it.
4. Prunable files: pages that are fully static register their source modules; after SSG,
   `pruneBuildOutput` (`lib/utils/prune-build.ts:28-135`) stubs unreachable server
   chunks and deletes their assets from `dist/server`.

### B.5 Dev-mode Cloudflare emulation

Two modes:

- **Without any Cloudflare vite plugin** (default): no emulation at all. Requests are
  served in **Node** via `environmentsPlugin.configureServer`
  (`environments.ts:136-157`): a post-middleware imports the rsc entry through
  `(server.environments.rsc as RunnableDevEnvironment).runner.import(entryId)` and calls
  `getRequestListener((req, ...) => mod.INTERNAL_runFetch(process.env, req, ...))` from
  `@hono/node-server`. `cloudflare:workers` import fails → adapter falls back to
  `app.fetch(req)`; env comes from `process.env` via `setAllEnv`.
- **With `@cloudflare/vite-plugin`** (documented path, `docs/guides/cloudflare.mdx:44-83`
  and e2e fixture `e2e/fixtures/cloudflare-adapter/waku.config.ts`): the user adds

  ```ts
  cloudflare({ viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] }, inspectorPort: false })
  ```

  to `config.vite.plugins`, plus `platform: 'neutral'` rolldown tweaks for `rsc`/`ssr`.
  The CF plugin turns the `rsc` env into a workerd-backed fetchable environment (module
  runner inside workerd), reads **wrangler.jsonc** for `main`/compat/bindings, and its
  middleware handles requests before Waku's Node bridge (Waku's runnable-environment
  middleware simply never fires; the cast at `environments.ts:138` only dereferences
  `.runner` at request time).

  There is **no miniflare/getPlatformProxy usage inside Waku itself** — emulation is
  wholly delegated to whichever Cloudflare vite plugin the user installs.

### B.6 Exhaustive wrangler touchpoints

`grep -rn wrangler packages/waku/src` yields exactly two files:

1. `packages/waku/src/adapters/cloudflare-build-enhancer.ts` — Node-side, runs inside
   the SSG step (B.4):
   - `readRootWranglerConfig` (`:15-51`): regex-scrapes `name`,
     `compatibility_date`, `compatibility_flags` from an existing
     `wrangler.json|jsonc|toml` (never imports wrangler).
   - `preBuild` (`:97-123`): **only if no wrangler config exists**, writes a fresh
     `wrangler.jsonc` at project root (`main: ./src/waku.server`, assets dir
     `./dist/public`, defaults `compatibility_date: '2025-11-17'`,
     `compatibility_flags: ['nodejs_als']`, `html_handling: 'drop-trailing-slash'`,
     `no_bundle: true`, ESModule rules — `getWranglerConfig`, `:69-95`).
   - `postBuild` (`:125-151`): **only if `dist/server/wrangler.json` doesn't exist**
     (i.e. `@cloudflare/vite-plugin` didn't emit one), writes a fallback
     `dist/server/wrangler.json` (`main: 'index.js'`) and a
     `.wrangler/deploy/config.json` redirect so a later `wrangler deploy` finds it.
2. `packages/waku/src/lib/utils/prune-build.ts:64` — a comment only.

No wrangler package import, no wrangler spawn, anywhere. `wrangler dev`/`deploy` appear
only in docs and e2e (`e2e/cloudflare-adapter.spec.ts:19` runs `npx wrangler dev`
against the built output as the *test harness*, not as framework machinery).

**Neutralizing for our constraints**: the enhancer chain comes from the server entry's
`buildEnhancers` array. Options (any one suffices):
- Provide our own adapter (thin fork of `adapters/cloudflare.ts` with
  `buildEnhancers: []` — the adapter is ~200 lines built entirely on public
  `waku/adapter-builders` + `waku/internals` exports, explicitly designed for
  third-party adapters per `docs/guides/adapter-authoring.mdx`), or
- keep the stock adapter and tolerate/delete the two fallback JSON files it writes
  (they are inert for us — nothing in our pipeline reads them), or
- point `unstable_adapter`/`buildEnhancers` at a no-op enhancer module we ship.

The fork option is cleanest and keeps zero wrangler-config files on disk.

---

## C. Adaptation plan: `Waku.ts` effectful `{ build, dev }` for cloudflare-tools

### C.1 Shape

Mirror `cloudflare-tools/packages/tools/e2e/src/Vite.ts` exactly: a
`Context.Service` `Waku` with `build(pluginOptions?, config?)`,
`dev(pluginOptions?, config?)` (Scoped, returns `{ url, server }`), `readBuildOutput()`.
Internally it *is* the `Vite` service pattern with Waku's plugins prepended — we can
even implement it as sugar over the existing `Vite` service since `Vite.build/dev`
already accept extra `config.plugins`:

```ts
const wakuConfig = resolveConfig({
  unstable_adapter: "<our-adapter-module>",   // see C.3
  ...userWakuConfig,
});

// dev
Vite.dev(
  { ...pluginOptions, viteEnvironments: { entry: "rsc", children: ["ssr"] },
    main: wakuServerEntryPath, compatibilityDate, compatibilityFlags: ["nodejs_als"] },
  { root, plugins: [combinedPlugins(wakuConfig)] },
);

// build (must set the preview-server global first — see C.4)
Vite.build(samePluginOptions, { root, plugins: [combinedPlugins(wakuConfig)] });
```

`Vite.ts`'s `output` plugin already handles multi-environment RSC builds: it collects
every non-client environment's bundle into `serverModules`, marks the entry via
`pluginOptions.viteEnvironments.entry` (`Vite.ts:122-179`, entry sorted first at
`Vite.ts:186-195`), records `clientDirectory` from the `client` env, and computes
`externalWorkspaces`. With `entry: "rsc"`, `serverModules[0]` becomes
`server/index.js` (Waku's worker entry) and `server/ssr/index.js` + chunks +
`__waku_build_metadata.js` follow — exactly the `BuildOutput` contract. The RSC
manifest special-case (`RSC_MANIFEST`, `Vite.ts:46-54`) applies as-is since Waku uses
`@vitejs/plugin-rsc`.

One gap: SSG files are written by Waku directly to `dist/public` *after* the client
env's `writeBundle` (during `buildApp` hooks), not through the bundle — but
`clientDirectory` is captured as a directory path, so consumers that upload the
directory get the SSG output for free. Ordering note: Waku's `staticBuildPlugin.buildApp`
runs before our `output` plugin's hooks complete only for bundle-emitted files; since we
read `clientDirectory` lazily (it's a path), no change needed. `dist/server` pruning
(B.4) rewrites some server chunk *files on disk* after `writeBundle`, while
`Vite.ts` captured chunk *contents in memory* at `writeBundle` time — see risk R5.

### C.2 Dev against cloudflare-runtime

Our plugin already supports the required topology
(`cloudflare-rolldown-plugin/src/options.ts:43-47` `viteEnvironments`, doc comment
explicitly citing `@vitejs/plugin-rsc` apps and `{ name: "rsc", childEnvironments:
["ssr"] }`), proven by `fixtures/react-router-rsc/e2e.config.ts`
(`viteEnvironments: { entry: "rsc", children: ["ssr"] }`). Dev flow: our
`dev-plugin.ts configureServer` starts workerd, connects `DistilledDevEnvironment`
module runners for `rsc` and `ssr`, and installs a post-middleware proxying every
request to workerd (`dev-plugin.ts:62-110`) — Waku's Node bridge middleware
(`environments.ts:143-156`) is registered but never reached, same as with upstream's CF
plugin. Bindings config comes from our plugin's `worker` option
(`CloudflareVitePluginOptions.worker`, `cloudflare-vite-plugin/src/plugin.ts:21-26`) —
**in-memory, no wrangler.json**.

Required config we must generate in-memory (the entire replacement for wrangler.jsonc):

- `main`: the worker entry module for dev. Use Waku's own rsc entry
  `require.resolve('waku/dist/lib/vite-entries/entry.server.js')` (its default export is
  the `ExportedHandler`, `entry.server.tsx:15`) — this matches what production builds
  (`dist/server/index.js`) contain, unlike upstream's `main: ./src/waku.server` which
  skips the `setAllEnv` wrapper. Passing `main` explicitly is **mandatory** because
  Waku's rsc env declares two inputs (`index` + `build`, `environments.ts:74-86`) and
  our dev plugin asserts exactly one (`dev-plugin.ts:76-80`
  "Expected exactly one entry in the input"); `pluginOptions.main` takes precedence in
  `optionsPlugin` (`options.ts:63`).
- `compatibilityDate` + `compatibilityFlags: ["nodejs_als"]` (or `nodejs_compat` for
  user deps; Waku core needs only ALS).
- `worker: { name, bindings, assets: { htmlHandling: "drop-trailing-slash", ... } }` —
  assets serve `dist/public` in preview/deploy; in dev, client assets are vite-served.
- rsc/ssr env tweaks from the docs (`docs/guides/cloudflare.mdx:52-74`):
  `optimizeDeps.include: ['hono/tiny']` (rsc), `['waku > rsc-html-stream/server']`
  (ssr). `platform: 'neutral'` for build is already applied by our `optionsPlugin` to
  the entry env (`options.ts:130-155`); verify child `ssr` env also resolves neutrally
  (upstream docs set it manually for both).

### C.3 What we reuse vs fork

**Reuse as-is (public API):**
- `unstable_combinedPlugins` + `unstable_resolveConfig` — the whole framework pipeline.
- `@vitejs/plugin-rsc` integration (already handled by our plugin's `viteEnvironments`
  + the `distilled-cloudflare:rsc` shim, `cloudflare-vite-plugin/src/plugin.ts:40-46`).
- Waku's stock cloudflare adapter *runtime* behavior (Hono app, `cloudflare:workers`
  env, `ASSETS` fetch) — worker-side code has zero wrangler coupling.
- `Vite.ts` service verbatim as the engine.

**Fork/reimplement (small):**
- **Adapter module** (`waku/adapters/cloudflare.ts`, ~200 lines): copy, drop
  `buildEnhancers: ['waku/adapters/cloudflare-build-enhancer']` (the only wrangler-file
  writer) and optionally the `removeGzipEncoding` wrangler-bug workaround
  (`cloudflare.ts:47-63,144-151`, upstream workers-sdk#6577 — evaluate against our
  runtime). Select it via `Config.unstable_adapter` (in-memory config; the
  `adapterAliasPlugin` resolves any module id, `adapter-alias.ts:12-25`). Users who
  wrote `import adapter from 'waku/adapters/cloudflare'` in `waku.server.tsx` bypass
  the alias — for them, either accept the two inert fallback JSON files or add a tiny
  resolve-alias plugin mapping `waku/adapters/cloudflare` → our fork (and/or
  `waku/adapters/cloudflare-build-enhancer` → a no-op enhancer).
- **Preview-server global for build**: our `build` must set
  `globalThis.__WAKU_START_PREVIEW_SERVER__` before `builder.buildApp()`
  (A.3/B.4). Minimal version: replicate `startPreviewServerImpl` with
  `vite.preview({ configFile: false, plugins: [combinedPlugins(config), cloudflareVitePlugin(...)] })`.
  If our vite plugin doesn't implement `configurePreviewServer` (it currently doesn't —
  no hits in `cloudflare-vite-plugin/src`), the adapter's *fallback* Node middleware
  (`cloudflare.ts:159-169`) still makes SSG work — rendering then happens in Node
  instead of workerd, which upstream explicitly supports ("Fallback ... for the case
  without @cloudflare/vite-plugin"). Later enhancement: preview-serve the built worker
  through cloudflare-runtime so SSG renders in workerd.
- **Dotenv/config-file loading**: skip `loadDotEnv`/`loadConfig`; accept config as a
  typed parameter (Effect config surface). Optionally support reading the user's
  `waku.config.ts` via `vite.runnerImport` for parity.

### C.4 Effort estimate

**Medium-small.** The dev path is expected to work with configuration only (Waku ≈ the
already-passing `react-router-rsc` fixture + Waku's plugin pipeline); build needs the
preview-server global plus the adapter fork. Most effort is validation (fixture app +
e2e) rather than new machinery.

### C.5 Risks / unknowns

- **R1 — `unstable_` API churn.** `combinedPlugins`/`resolveConfig`/adapter-builder
  exports are all `unstable_`-prefixed and Waku is `1.0.0-beta`; signatures move
  between betas (the whole adapter system was rewritten from the old
  `DEPLOY_TARGET`/`unstable_viteConfigs` model recently). Pin the version.
- **R2 — input merging in build.** Our `optionsPlugin` sets
  `rollupOptions.input = wrapInput(main)` on the entry env (`options.ts:67-70,130-155`)
  while Waku needs the extra `build` input (`entry.build.js`) to emit
  `dist/server/build.js` for SSG (`static-build.ts:49-56`). Vite `mergeConfig` merges
  the two input objects key-wise (names `index` + `build`), but if either side ends up
  *replacing* instead of merging, SSG breaks with "cannot find dist/server/build.js".
  Must be verified first thing; worst case our plugin needs a
  "preserve existing inputs" tweak (we own it, trivial).
- **R3 — dual dev middlewares.** Waku's Node request bridge and our workerd proxy are
  both registered as post-middlewares; correctness currently depends on ours running
  first (plugin order). Deterministic fix if flaky: override
  `waku:vite-plugins:environments`'s `configureServer` via the documented
  plugin-name-override mechanism (`combined-plugins.ts:30-39`) — but that would also
  drop its `config()` env definitions, so prefer ordering (our plugin before
  `combinedPlugins` in the plugins array) or a stub middleware guard.
- **R4 — SSG-under-workerd parity.** Without preview support in our vite plugin, SSG
  renders in Node (adapter fallback). Pages that read Cloudflare bindings at build time
  would differ; upstream has the same limitation without `@cloudflare/vite-plugin`.
- **R5 — pruned chunks vs in-memory `serverModules`.** `pruneBuildOutput` stubs
  static-only server chunks *on disk* after `writeBundle`
  (`prune-build.ts:117-132`), but `Vite.ts` captured chunk contents in memory during
  `writeBundle` (`Vite.ts:145-148`). Deploying the in-memory copies uploads unpruned
  chunks — functionally correct but larger; if we care, re-read pruned files from disk
  in `collectServerModules` (compare hash/mtime) or read all server modules from disk
  after `buildApp` resolves.
- **R6 — `nodejs_als` vs our runtime defaults.** Waku requires AsyncLocalStorage
  (`nodejs_als`); confirm cloudflare-runtime's workerd config enables it (our
  `nodejsAlsPlugin` exists in the rolldown plugin set, `plugin.ts:5,34`).
- **R7 — Durable Objects.** Waku cannot host DOs in-app ("Durable Objects cannot
  currently be defined in a Waku app", `docs/guides/cloudflare.mdx:134`) — service
  bindings only; matters for alchemy resource modeling.
