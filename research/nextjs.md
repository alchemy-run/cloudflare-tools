# Next.js — programmatic dev/build, adapter hooks, and cloudflare-tools adaptation spec

Research target: `upstream/next.js` (shallow clone, HEAD `8669b07f19`, `packages/next` version **16.3.0-canary.90**).
All file paths below are relative to the submodule root (`/Users/john/Developer/Alchemy/alchemy-effect/cloudflare-tools/upstream/next.js`) unless prefixed otherwise.

Scope note: the Cloudflare integration itself (`@opennextjs/cloudflare`) is covered by a sibling spec. This document covers what **Next.js core** exposes: programmatic build/dev entry points, the `.next` output layout an adapter consumes, the new first-class **adapter API** (`adapterPath` / `onBuildComplete`), standalone output, and the minimal-mode server.

---

## A. Programmatic hooks

### A.1 Production build: `build()` — a plain exported async function

The CLI chain is:

1. `packages/next/src/bin/next.ts` (commander) →
2. `packages/next/src/cli/next-build.ts` — `const nextBuild = async (options, directory)` (line 36), which does arg parsing, telemetry, memory-debug setup, and then **directly calls the reusable layer** (line 123):

```ts
// packages/next/src/cli/next-build.ts:6,123
import build from '../build'
...
return build(
  dir,
  experimentalAnalyze,
  profile,
  debug || Boolean(process.env.NEXT_DEBUG_BUILD),
  debugPrerender,
  !mangling,
  experimentalAppOnly,
  bundler,                 // Bundler.Turbopack by default (lib/bundler.ts parseBundlerArgs)
  experimentalBuildMode,   // 'default' | 'compile' | 'generate' | 'generate-env'
  traceUploadUrl,
  debugBuildPathsPatterns,
  enabledFeatures
)
```

3. The reusable programmatic layer is the **default export of `packages/next/src/build/index.ts`**:

```ts
// packages/next/src/build/index.ts:930
export default async function build(
  dir: string,
  experimentalAnalyze = false,
  reactProductionProfiling = false,
  debugOutput = false,
  debugPrerender = false,
  noMangling = false,
  appDirOnly = false,
  bundler = Bundler.Turbopack,
  experimentalBuildMode: 'default' | 'compile' | 'generate' | 'generate-env',
  traceUploadUrl: string | undefined,
  debugBuildPathsPatterns: string[] | undefined,
  enabledFeatures: Record<string, unknown> = {}
): Promise<void>
```

Programmatic invocation from Node (against the published package):

```ts
const build = (await import("next/dist/build/index.js")).default;
await build(projectDir, false, false, false, false, false, false,
  /* bundler */ undefined as any /* Bundler.Turbopack default */,
  "default", undefined, undefined, {});
```

**Stability**: `next`'s `package.json` has **no `"exports"` map** (verified — only `main: "./dist/server/next.js"`), so deep imports like `next/dist/build` and `next/dist/server/lib/start-server` resolve. These are internal-path imports, but they are the *exact* modules the CLI and the generated standalone `server.js` use (the standalone template literally emits `require('next/dist/server/lib/start-server')`, see `packages/next/src/build/utils.ts:1444`), so they are stable in practice and covered by Next's own e2e suite. The positional-arg signature of `build()` does drift across minors (it gained `debugBuildPathsPatterns`/`enabledFeatures` recently) — pin the Next version or introspect `build.length`.

**Config injection for build**: `build()` takes **no config object**. It calls `loadConfig(PHASE_PRODUCTION_BUILD, dir, …)` itself (`build/index.ts:~1005`). The injection points are:

- `next.config.{js,ts,mjs}` on disk (arbitrary user code — can read env).
- **`NEXT_ADAPTER_PATH` env var** → becomes `config.adapterPath` via `defaultConfig` (`packages/next/src/server/config-shared.ts:2112`: `adapterPath: process.env.NEXT_ADAPTER_PATH || undefined`). The adapter's `modifyConfig` then rewrites the fully-resolved `NextConfigComplete` in memory for **every phase** (build *and* dev *and* start) — see §B.1.
- Env-driven toggles (`TURBOPACK`, `NEXT_RSPACK`, `NEXT_DEBUG_BUILD`, …).

**Process-hygiene caveats (why to child-process it anyway)**:

- `build()` forks static-generation workers (`lib/worker.ts` / jest-worker); a failing prerender worker "exits the process directly (`prerenderEarlyExit`)" — comment at `build/index.ts:965`.
- `experimentalBuildMode: 'generate-env'` calls `process.exit(0)` (`build/index.ts:1093,1108`); segment-config validation errors call `process.exit(1)` (`build/index.ts:4412`); `Lockfile.acquireWithRetriesOrExit` (`build/index.ts:1156`) can exit.
- It installs `process.once('exit')` handlers and mutates global trace/telemetry state.

So: `build()` **is** programmatically callable in-process (it resolves or throws for normal success/failure), but a robust integration runs it in a disposable child Node process (`node -e "require('next/dist/build').default(...)"` or a forked runner script) and treats non-zero exit as failure. This is still *not* CLI-spawning — no arg parsing, telemetry preamble, or SIGINT choreography from `cli/next-build.ts` is involved.

### A.2 Dev server: the layer cake, and which layer to call

The CLI (`packages/next/src/cli/next-dev.ts:205 nextDev`) does **not** run the dev server in-process: it `fork()`s `packages/next/src/server/lib/start-server.ts` as a child (`next-dev.ts:347,395`) with `NEXT_PRIVATE_WORKER=1`, passes options over IPC (`child.send({ nextWorkerOptions })`, `next-dev.ts:433`), receives `{ nextServerReady, port, distDir }` back (`next-dev.ts:434-447`), and restarts the child on `RESTART_EXIT_CODE` (config-file change, memory threshold). The fork exists for crash/restart isolation and NODE_OPTIONS massaging — none of it is needed programmatically.

Peeling inward, the reusable layers are:

**Layer 1 — `startServer` (`packages/next/src/server/lib/start-server.ts:184`)**

```ts
export interface StartServerOptions {          // start-server.ts:125
  dir: string
  port: number
  isDev: boolean
  hostname?: string
  allowRetry?: boolean
  customServer?: boolean
  minimalMode?: boolean
  keepAliveTimeout?: number
  selfSignedCertificate?: SelfSignedCertificate  // dev only
  serverFastRefresh?: boolean
}
export async function startServer(serverOptions: StartServerOptions): Promise<{ distDir: string }>
```

Creates its own `http.Server`, retries `EADDRINUSE` (dev, +1 up to 10 times, `start-server.ts:300-316`), exposes the chosen port only via `process.env.PORT` and `process.env.__NEXT_PRIVATE_ORIGIN` mutation (`start-server.ts:364-366`), registers its own `SIGINT`/`SIGTERM` handlers that call `process.exit` (`start-server.ts:478-481`, suppressible with `NEXT_MANUAL_SIG_HANDLE`), and watches config files, restarting via `process.exit(RESTART_EXIT_CODE)` (`start-server.ts:557-608`). This is what `next start` and the standalone `server.js` call. **Usable, but its lifecycle is process-global** — fine in a dedicated child process, hostile to in-process Effect scoping.

**Layer 2 — `getRequestHandlers` (`start-server.ts:139`) → `initialize` (`packages/next/src/server/lib/router-server.ts:88`)**

```ts
// router-server.ts:88
export async function initialize(opts: {
  dir: string
  port: number
  dev: boolean
  onDevServerCleanup: ((listener: () => Promise<void>) => void) | undefined
  server?: import('http').Server
  minimalMode?: boolean
  hostname?: string
  keepAliveTimeout?: number
  customServer?: boolean
  experimentalHttpsServer?: boolean
  serverFastRefresh?: boolean
  startServerSpan?: Span
  quiet?: boolean
}): Promise<ServerInitResult>

// packages/next/src/server/lib/render-server.ts:13
export type ServerInitResult = {
  requestHandler: RequestHandler       // (req, res, parsedUrl?) => Promise<void>
  upgradeHandler: UpgradeHandler       // HMR websocket
  server: NextServer
  closeUpgraded: () => void
  distDir: string
  experimentalFeatures: ConfiguredExperimentalFeature[]
  cacheComponents: boolean
  partialPrefetching?: boolean | 'unstable_eager'
  agentRules?: boolean
}
```

`initialize` is the real dev engine: it `loadConfig(PHASE_DEVELOPMENT_SERVER, dir)` (`router-server.ts:111`), builds the filesystem/route checker, and in dev calls `setupDevBundler` (`packages/next/src/server/lib/router-utils/setup-dev-bundler.ts`) which creates the **Turbopack hot reloader** (`setup-dev-bundler.ts:236-241`: `createHotReloaderTurbopack` from `./hot-reloader-turbopack`) and starts it (`:278`). It then constructs a `NextServer` via `render-server.ts` `initializeImpl` (`render-server.ts:117`: `next({ ...opts, customServer: false })`). No sockets are opened by `initialize` itself — you attach `requestHandler`/`upgradeHandler` to any `http.Server` you own. Shutdown = `result.server.close()` + `result.closeUpgraded()` + the cleanup listeners you collected via `onDevServerCleanup`.

**Layer 3 — the public custom-server API: `next({ dev: true })` (`packages/next/src/server/next.ts`)**

```ts
// next.ts:615 — the default export of the `next` package
function createServer(options: NextServerOptions & NextBundlerOptions): NextWrapperServer
// next.ts:426 — what you get when customServer !== false
class NextCustomServer implements NextWrapperServer {
  async prepare() {                                      // next.ts:465
    if (this.options.dev) process.env.__NEXT_DEV_SERVER = '1'
    const { getRequestHandlers } = require('./lib/start-server')
    ...
    const initResult = await getRequestHandlers({
      dir: this.options.dir!,
      port: this.options.port || 3000,
      isDev: !!this.options.dev,
      onDevServerCleanup,
      hostname: this.options.hostname || 'localhost',
      minimalMode: this.options.minimalMode,
      quiet: this.options.quiet,
    })
    this.init = initResult
  }
  getRequestHandler(): RequestHandler { ... }            // next.ts:507
  async close() {                                        // next.ts:606
    await Promise.allSettled([this.init?.server.close(), this.cleanupListeners?.runAll()])
  }
}
```

This is the **documented, semver-public** custom-server API (`import next from 'next'`). `getRequestHandler()` also lazily wires the HMR websocket upgrade onto the caller's `http.Server` (it reaches `req.socket.server` — `next.ts:491-505`, `setupWebSocketHandler`). Bundler choice is passed as `turbopack: true` / `webpack: true` (`NextBundlerOptions`, `next.ts:54-61`; default is `TURBOPACK=auto`, `next.ts:632-636`).

**Recommended programmatic dev shape** (this is what our Effect service should wrap):

```ts
import next from "next"; // dist/server/next.js — public entry

const app = next({ dev: true, dir, hostname: "localhost", port });
await app.prepare();                       // spins up Turbopack dev bundler
const handler = app.getRequestHandler();
const server = http.createServer((req, res) => handler(req, res));
server.listen(port, "localhost");          // caller owns port ⇒ caller knows the URL
...
await app.close(); server.close();         // scope release
```

Port/URL: entirely caller-owned (the `port` option only seeds HMR/asset URLs and the dev bundler; the listening socket is ours). Shutdown: `app.close()` — no signal handlers are installed on this path.

**Config injection on the dev path — important nuance**: `NextServerOptions.conf` (custom config object) is honored only by the internal `NextServer` wrapper's own config load (`next.ts:339-351`, `SYMBOL_LOAD_CONFIG` passes `customConfig: this.options.conf`). But the `NextCustomServer.prepare()` path goes through `router-server.ts initialize`, whose `loadConfig` call (`router-server.ts:111-121`) does **not** take `customConfig`, and `render-server.ts initializeImpl` does not forward `conf`. **Therefore in dev, config effectively comes from `next.config.*` on disk — or from an adapter's `modifyConfig` (env `NEXT_ADAPTER_PATH`), which *does* run on this path** (see §B.1). That adapter hook is our clean in-memory config-injection mechanism.

### A.3 Production serving: `NextServer` / minimal mode / standalone

- `next start` → `cli/next-start.ts:12` imports `startServer` from `server/lib/start-server` and calls it with `{ dir, isDev: false, port, hostname, keepAliveTimeout }` (line ~90).
- `output: 'standalone'` (config) makes `build()` call `writeStandaloneDirectory` (`build/index.ts:684`, invoked at `:4272-4290`) → `copyTracedFiles` (`build/utils.ts`), which NFT-traces `next-server.js` plus every page entry and emits a self-contained tree at **`.next/standalone/`**: traced `node_modules`, `.next/server/**`, `required-server-files.json`, and a generated **`server.js`** (`build/utils.ts:1409-1466`) whose body is:

```js
const nextConfig = /* inlined serialized config */
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)
require('next')
const { startServer } = require('next/dist/server/lib/start-server')
startServer({ dir, isDev: false, config: nextConfig, hostname, port: currentPort, allowRetry: false, keepAliveTimeout })
```

  Note: `.next/static` and `public/` are **not** copied into standalone; deployers must serve them separately (this is the "static asset dir" an adapter owns).
- **Minimal mode** — the contract Vercel/OpenNext use: `BaseServer` constructor sets `this.minimalMode = minimalMode || !!process.env.NEXT_PRIVATE_MINIMAL_MODE` (`packages/next/src/server/base-server.ts:530-532`). In minimal mode the server performs **no route matching, no ISR cache writes, no revalidation** — it trusts an upstream routing/caching layer and reads the pre-matched route from the `x-matched-path` header (`MATCHED_PATH_HEADER` consumed at `base-server.ts:1111,1129`; RSC pathname normalization only enabled in minimal mode, `base-server.ts:544-546`). `minimalMode` is a first-class option on `server/base-server.ts:210 Options` (`minimalMode?: boolean`) and on `StartServerOptions`/`initialize`. This is exactly the "NextServer request handling" surface an adapter's worker embeds: construct `NextNodeServer` (`server/next-server.ts` default export) with `{ conf, dir, minimalMode: true, customServer: false }`, call `getRequestHandler()`, and front it with your own router.

### A.4 Verdict

- **Build**: programmatic — `next/dist/build` default export `build(dir, …)`. No CLI spawn required (child-*process* wrapper recommended purely for `process.exit` hygiene, invoking the same function).
- **Dev**: programmatic — public `next({ dev: true }).prepare()` + caller-owned `http.Server`; or one layer deeper, `getRequestHandlers`/`initialize` from `next/dist/server/lib/router-server` for handler-only access with `ServerInitResult`. No CLI spawn required.

---

## B. What Next.js core exposes for a Cloudflare adapter

### B.1 The first-class adapter API (`adapterPath` — the successor to standalone hacks)

Next 16 has an (undocumented-but-shipped) **deployment adapter API**:

- **Config**: `adapterPath?: string` on `NextConfig` (`packages/next/src/server/config-shared.ts:1606`), defaulting from **env `NEXT_ADAPTER_PATH`** (`config-shared.ts:2112`). The path is `require.resolve`d then dynamically imported.
- **Interface** (`packages/next/src/build/adapter/build-complete.ts:368`):

```ts
export interface NextAdapter {
  name: string
  modifyConfig?: (config: NextConfigComplete, ctx: {
    phase: PHASE_TYPE; nextVersion: string; projectDir: string
  }) => Promise<NextConfigComplete> | NextConfigComplete

  onBuildComplete?: (ctx: {
    routing: {
      beforeMiddleware: Route[]; middlewareMatchers: Route[]
      beforeFiles: Route[]; afterFiles: Route[]
      dynamicRoutes: Route[]; onMatch: Route[]; fallback: Route[]
      shouldNormalizeNextData: boolean
      rsc: RoutesManifest['rsc']
    }
    outputs: AdapterOutputs
    projectDir: string; repoRoot: string; distDir: string
    config: NextConfigComplete; nextVersion: string; buildId: string
  }) => Promise<void> | void
}
```

- **`modifyConfig` runs on EVERY phase** — `applyModifyConfig` is called from `loadConfig` (`packages/next/src/server/config.ts:1692-1718`), i.e. during `next build`, `next dev`, and `next start`. This is the sanctioned way to rewrite the resolved config in memory (set `output`, `cacheHandler`, `deploymentId`, disable image optimization, etc.) without touching the user's `next.config`.
- **`onBuildComplete`** is invoked near the end of `build()` (`packages/next/src/build/index.ts:4238-4270`) via `handleBuildComplete` (`build/adapter/build-complete.ts:464`), *before* `output: 'standalone'` processing.
- **`AdapterOutputs`** (`build-complete.ts:328-336`) is a fully-resolved inventory of the build:

```ts
export interface AdapterOutputs {
  pages: AdapterOutput['PAGES'][]           // pages-router pages
  middleware?: AdapterOutput['MIDDLEWARE']  // pathname '/_middleware', edge or nodejs
  appPages: AdapterOutput['APP_PAGE'][]     // includes matching '.rsc' outputs
  pagesApi: AdapterOutput['PAGES_API'][]
  appRoutes: AdapterOutput['APP_ROUTE'][]
  prerenders: AdapterOutput['PRERENDER'][]  // ISR/PPR entries w/ fallback files, allowQuery, bypassToken
  staticFiles: AdapterOutput['STATIC_FILE'][] // /_next/static/**, static HTML, immutableHash
}
```

  Every function output carries (`SharedRouteFields`, `build-complete.ts:59-143`): `id`, `filePath` (built entry on disk), `pathname`, `sourcePage`, `runtime: 'nodejs' | 'edge'`, `assets: Record<repoRelPath, absPath>` (**NFT-traced** closure incl. `node_modules`), `assetsHashes`, `wasmAssets`, and for edge outputs `edgeRuntime: { modulePath, entryKey: 'middleware_${name}', handlerExport: 'handler' }` (`build-complete.ts:676-679`). Node outputs' assets are assembled from `${entry}.nft.json` traces (`handleTraceFiles`, `build-complete.ts:596-624`) plus shared server assets (`getSharedNodeAssets`).
- Routing arrays are converted from `redirects`/`rewrites`/`headers` + dynamic-route regexes using `next/dist/compiled/@vercel/routing-utils` (`build-complete.ts:17-21`) — i.e. the adapter receives an ordered, provider-neutral routing program (`Route = { sourceRegex, destination?, headers?, has?, missing?, status?, priority? }`, `build-complete.ts:354-366`).

This API is precisely "what the CF integration consumes" going forward (OpenNext currently parses the manifests below by hand; `adapterPath` supersedes that).

### B.2 `.next` build-output layout (what any adapter reads)

Manifest name constants — `packages/next/src/shared/lib/constants.ts`:

| Constant (line) | File | Content |
|---|---|---|
| `ROUTES_MANIFEST` (98) | `.next/routes-manifest.json` | redirects/rewrites/headers, dynamic route regexes, `rsc` config, basePath/i18n |
| `PRERENDER_MANIFEST` (96) | `.next/prerender-manifest.json` | ISR routes, fallbacks, revalidate/expire, `preview.previewModeId` (bypass token) |
| `MIDDLEWARE_MANIFEST` (104) | `.next/server/middleware-manifest.json` | edge `middleware` + edge `functions`: files, `entrypoint`, matchers, env, wasm/assets |
| `SERVER_FILES_MANIFEST` (100) | `.next/required-server-files.json` | serialized `NextConfigComplete` + file list required at runtime |
| `PAGES_MANIFEST` (87) | `.next/server/pages-manifest.json` | page → compiled `.js` |
| `APP_PATHS_MANIFEST` (88) | `.next/server/app-paths-manifest.json` | app route → compiled `.js` |
| `BUILD_MANIFEST` (90) | `.next/build-manifest.json` | client JS per page |
| `FUNCTIONS_CONFIG_MANIFEST` (91) | `.next/server/functions-config-manifest.json` | per-route `maxDuration`/`regions`/node-middleware matchers |
| `SERVER_DIRECTORY` (110) | `.next/server/` | compiled server entries: `server/pages/**.js`, `server/app/**.js` (+ `.html`/`.body`/`.meta`/`.rsc` prerender artifacts), `server/middleware.js` (node middleware), edge chunks |

Plus: `.next/static/**` (immutable client assets, served under `/_next/static`), `.next/BUILD_ID`, per-entry `*.js.nft.json` traces, `next-server.js.nft.json`, and (turbopack) `immutable-static-hashes.json` (`build-complete.ts:556-563`). **`_routes.json` is not a Next.js concept** — nothing in `packages/next/src` emits it; it's produced by Cloudflare-side tooling (OpenNext/Pages) from the routing data above.

### B.3 Dev-mode "Cloudflare emulation" in core: none

- Dev bundling is **Turbopack** in-process via native bindings (`setup-dev-bundler.ts:236-278`), not Vite; there is no vite-environment concept.
- Edge-runtime routes/middleware in dev (and `next start`) execute in the **`edge-runtime` VM sandbox** (`packages/next/src/server/web/sandbox/sandbox.ts:3` imports `next/dist/compiled/edge-runtime`) — a Node `vm` emulation, not workerd, not miniflare.
- **`grep -rn wrangler packages/next/src --include='*.ts'` (excluding tests) → zero hits.** Next core has no dependency on wrangler, `wrangler.json`, miniflare, or `getPlatformProxy`. All Cloudflare-ness lives in the external adapter (`@opennextjs/cloudflare` calls wrangler's `getPlatformProxy` from inside the user's `next.config` via `initOpenNextCloudflareForDev()` — sibling spec).
- Bindings/env access pattern available to core: `next.config.ts` and `instrumentation.ts` run arbitrary user code inside the dev/server Node process, so an integration can install a `globalThis`-level binding proxy there; runtime code then reads it via whatever accessor the adapter prescribes. Core itself only offers `process.env`.

### B.4 Minimal-mode server as the embeddable request engine

For a worker that *hosts* Next (rather than proxying to it), core exposes `NextNodeServer` (`packages/next/src/server/next-server.ts`, default export; `Options` at `server/base-server.ts:210` includes `conf`, `dir`, `minimalMode`, `customServer`, `port`, `hostname`). With `minimalMode: true` (`base-server.ts:530-532`) the embedder is responsible for routing (send `x-matched-path`, `base-server.ts:1111`), caching, and asset serving. This is the server OpenNext bundles into the Cloudflare worker.

---

## C. Adaptation plan for cloudflare-tools (`Next` Effect service, Vite.ts-shaped)

Target: a `packages/tools/e2e/src/Next.ts` exposing

```ts
class Next extends Context.Service<Next, {
  build: (options?) => Effect<BuildOutput, NextError>
  dev:   (options?) => Effect<{ url: string; app: NextDevHandle }, NextError, Scope.Scope>
  readBuildOutput: () => Effect<BuildOutput, PlatformError>
}>()("@alchemy/Next") {}
```

with Vite.ts's `BuildOutput = { clientDirectory, serverModules (entry first), externalWorkspaces }` (`cloudflare-tools/packages/tools/e2e/src/Vite.ts:25-29`).

### C.1 `dev`

- Load `next` from the project root with the same `createRequire(root/package.json)` + `pathToFileURL` dance as `Vite.ts` `load()` (Vite.ts:69-85), importing the **public** entry (`next` → `dist/server/next.js`).
- `Effect.acquireRelease`: acquire = `next({ dev: true, dir, hostname, port }); await app.prepare(); http.createServer(app.getRequestHandler()).listen(port)`; release = `app.close()` then `server.close()`. URL is deterministic from our own listen call (unlike `startServer`, no `process.env.PORT` sniffing needed).
- **Cloudflare fidelity**: Next dev executes route code in Node (nodejs runtime) or the edge-runtime VM — not in our `cloudflare-runtime` workerd. Achieving *true* workerd dev for Next means running Turbopack + Next's render pipeline inside workerd, which core does not support. Realistic tiers:
  1. **Bindings-proxy tier (ship first)**: run `next dev` in Node; expose our `cloudflare-runtime` bindings to the app through a loopback proxy service (our equivalent of wrangler's `getPlatformProxy`, but backed by `@distilled.cloud/cloudflare-runtime`'s binding plugins + magic-proxy-style RPC into a workerd instance we own). Injected via a small module the user calls in `next.config.ts` (mirroring `initOpenNextCloudflareForDev`) or automatically via our adapter's `modifyConfig` setting an `instrumentation` hook. No wrangler, no wrangler.json — binding config comes from alchemy's in-memory model.
  2. **Prod-parity tier**: `build` (below) + deploy the emitted worker to `cloudflare-runtime` locally, i.e. "preview" rather than HMR dev. Cheap to build once `build` works.
- Shutdown quirk to guard: Next's dev path can `process.exit(RESTART_EXIT_CODE)` on config-file change only in the `startServer` layer; the custom-server path (`NextCustomServer`) does **not** install the config watcher (start-server.ts:557 is inside `startServer`) — so we own restarts (watch `next.config.*` ourselves if wanted).

### C.2 `build`

- Invoke `next/dist/build` default export with `dir` and defaults; run it in a forked child (see §A.1 caveats), passing `NEXT_ADAPTER_PATH=<our adapter module>` in the child env.
- **Our adapter module** (the key new artifact, ~small):
  - `modifyConfig`: force settings needed for workerd (e.g. `output` handling, `images.unoptimized` or custom loader, `cacheHandler` pointing at our KV/DO-backed handler, `deploymentId`), all in memory — replaces every "generate a wrangler.json / patch next.config" step upstream tools require.
  - `onBuildComplete`: serialize `{ routing, outputs, buildId, distDir, config-subset }` to `dist/next-adapter-output.json`. This hands us, with zero manifest parsing: every server entry `filePath`, its NFT-traced `assets` closure, edge entries with `edgeRuntime.modulePath/entryKey/handlerExport`, all prerender/fallback artifacts, and all static files with `immutableHash`.
- **Worker assembly** (the large piece): Next's nodejs-runtime entries are CommonJS Node programs with traced `node_modules` — they do not run on workerd as-is. Two options:
  a. **Delegate to `@opennextjs/cloudflare`** for the bundling/shimming (sibling spec) and only replace its wrangler/dev half with our runtime; or
  b. **Own pipeline**: bundle `NextNodeServer` in minimal mode (+ our routing shim implementing the `routing` program from `onBuildComplete`, incl. `x-matched-path` injection per §B.4) with `cloudflare-rolldown-plugin` using `nodejs_compat`; emit prerender fallbacks + `.next/static` as assets. This is effectively re-doing OpenNext's hardest work; expect a long tail (Node API gaps, `require` graphs, React server condition).
- **BuildOutput mapping**:
  - `clientDirectory`: stage a dir containing `outputs.staticFiles` (or `.next/static` + `public` + prerendered HTML) laid out by `pathname` — this is what the assets binding serves.
  - `serverModules`: entry-first list of our bundled worker chunks (hash via `sha256` as in Vite.ts `toOutputFile`, Vite.ts:115-120).
  - `externalWorkspaces`: walk `outputs.*[].assets` keys; any traced file outside the project root → `findUp(package.json)` exactly like Vite.ts:198-209 (`assets` are absolute paths, so the same algorithm applies verbatim).

### C.3 Reuse vs fork vs build

| Piece | Verdict |
|---|---|
| `build()` deep import + `NEXT_ADAPTER_PATH` | reuse as-is (no fork of Next needed) |
| `NextAdapter` (`modifyConfig`/`onBuildComplete`) | **write ours** (~200 LoC serializer) |
| `next({dev:true})` custom-server API | reuse as-is |
| Bindings dev proxy (getPlatformProxy-equivalent) | **build on `cloudflare-runtime`** (new, medium) |
| workerd server bundle (minimal-mode NextServer + routing shim + cache handler) | fork/adapt from `@opennextjs/cloudflare` or build (large) |
| `_routes.json` / asset config | generate from `outputs.staticFiles` + `routing` (small) |
| wrangler / wrangler.json | not needed anywhere — Next core has zero coupling (§B.3); all config surface is `NextConfig` fields we set in `modifyConfig` + our own runtime config |

### C.4 Risks / unknowns

1. **Adapter API stability**: `adapterPath`/`NextAdapter` is new in the 16.x canary line and undocumented; shape may drift (it's clearly built for Vercel's own use). Mitigation: pin Next version range; fall back to manifest parsing (`.next` layout §B.2) which has been stable for years.
2. **`build()` positional signature drift** across minors (see §A.1). Mitigation: version-gate the call or vendor a thin shim per supported range.
3. **workerd compatibility of the Node server bundle** — the dominant cost if we don't reuse OpenNext: React vendored builds, `require` cycles, `AsyncLocalStorage`, streaming, `after()`/`waitUntil` mapping, ISR cache handler semantics.
4. **Dev fidelity gap**: dev tier 1 runs user code in Node/edge-runtime-VM, not workerd; behavioral differences (CF-specific APIs, `cf` object, limits) only surface in the preview tier.
5. **Turbopack native bindings**: dev and default build require `@next/swc`/turbopack binaries per platform; in sandboxed CI our runner must allow them.
6. **In-process `build()` may `process.exit`** in specific modes/failures — must run forked (§A.1).
7. **`conf` not honored on the dev custom-server path** (§A.2) — all dev config injection must go through `next.config.*` on disk or adapter `modifyConfig`; don't design around `next({ conf })`.

---

## Appendix: CLI → programmatic call-graph summary

```
next build ─ cli/next-build.ts:nextBuild ──────────────► build/index.ts:930 build()          [callable]
                                                            └─ config.adapterPath? → build/adapter/build-complete.ts:464 handleBuildComplete
                                                            └─ config.output==='standalone' → build/index.ts:684 writeStandaloneDirectory
next dev ── cli/next-dev.ts:nextDev ─ fork ─► server/lib/start-server.ts:184 startServer     [callable, process-global]
                                                            └─► start-server.ts:139 getRequestHandlers
                                                                  └─► server/lib/router-server.ts:88 initialize   [callable, handler-only]
                                                                        ├─ setupDevBundler (Turbopack HMR)
                                                                        └─► server/lib/render-server.ts:117 next({customServer:false})
import next from 'next' ─ server/next.ts:615 createServer ─► NextCustomServer.prepare (next.ts:465) ─► getRequestHandlers (same engine)  [public API]
next start ─ cli/next-start.ts ─► startServer({ isDev:false })
.next/standalone/server.js ─► require('next/dist/server/lib/start-server').startServer  (template: build/utils.ts:1409-1466)
minimal-mode embed ─ server/next-server.ts default export + base-server.ts:210 Options{minimalMode} + x-matched-path (base-server.ts:1111)
```
