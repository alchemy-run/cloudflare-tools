# Framework Integrations — Implementation Plan

Synthesis of the research specs in this directory:
[nextjs.md](./nextjs.md), [opennextjs-cloudflare.md](./opennextjs-cloudflare.md),
[astro.md](./astro.md), [sveltekit.md](./sveltekit.md), [waku.md](./waku.md),
[internals-cloudflare-tools.md](./internals-cloudflare-tools.md),
[internals-alchemy-website.md](./internals-alchemy-website.md).

Goal: first-class, wrangler-free integrations for **Waku, Astro, SvelteKit, and Next.js**
in cloudflare-tools (build + dev against `@distilled.cloud/cloudflare-runtime`), each
producing the `BuildOutput { clientDirectory, serverModules (entry first), externalWorkspaces }`
contract, then surfaced in alchemy as `Cloudflare.Website.<Framework>` resources.

---

## 0. The one-sentence verdict per framework

| Framework | Path | Effort |
|---|---|---|
| **Waku** | Rides the existing `cloudflare-vite-plugin` path almost unchanged — configuration + a ~200-line adapter fork | medium-small |
| **Astro** | Rides the vite-plugin path via a fork of the `@astrojs/cloudflare` integration (swap `@cloudflare/vite-plugin` for ours); build/dev driven through astro's public `build()`/`dev()` | medium |
| **SvelteKit** | Vite-driven build, but **not** through our vite plugin's environments: custom in-memory kit `Adapter` + a post-adapt rolldown pass; dev keeps kit's Node SSR with an `emulate()` shim | medium |
| **Next.js** | Bespoke: reuse the `@opennextjs/cloudflare` build pipeline (pinned deep import, in-memory config), add our own final bundle pass, serve via `cloudflare-runtime` (preview-parity dev first, HMR dev phase 2) | large |

All four are **fully programmatic — zero CLI spawning of framework binaries by us**
(Next's pipeline internally spawns `next build`; that is upstream orchestration, not ours),
and **zero wrangler**: every piece of config wrangler.json would have carried is expressed
as in-memory plugin/adapter options and, in alchemy, Worker props.

---

## 1. Package layout in cloudflare-tools

```
packages/framework-core/        @distilled.cloud/framework-core        (new, published, small)
packages/waku/                  @distilled.cloud/waku                  (new, published)
packages/astro/                 @distilled.cloud/astro                 (new, published)
packages/sveltekit/             @distilled.cloud/sveltekit             (new, published)
packages/nextjs/                @distilled.cloud/nextjs                (new, published; OpenNext-based)
packages/cloudflare-runtime/    (existing — gains local KV, Images emulation, self-service binding,
                                 and later the Node-side bindings proxy)
packages/tools/e2e/             (existing — generalized from Vite-only to Framework services)
fixtures/{waku,astro,sveltekit,nextjs}/
```

### 1.1 `@distilled.cloud/framework-core` (shared scaffolding — warranted)

Extract from `packages/tools/e2e/src/Vite.ts` (and mirror of alchemy's `Bundle/Vite.ts`):

- `BuildOutput` / `OutputFile` types + sha256 `toOutputFile`.
- The `alchemy:build-output` vite collector plugin (env-prefixed server chunk names,
  entry-environment detection, RSC-manifest disk reads, `externalDirectories` capture),
  parameterized by `{ entryEnvironment, skipEnvironments }` (Astro needs to skip `prerender`).
- `collectServerModules` (entry-first sort), `collectExternalWorkspaces` (cached `findUp(package.json)`).
- `loadProjectModule(root, specifier)` — the `createRequire` + `pathToFileURL` dance every
  framework service needs to load the *project's* vite/astro/next/waku instead of ours.
- A `readServerModulesFromDisk(entryPath, rules)` helper (module rules: `.js/.mjs`→ESModule,
  `.wasm`→CompiledWasm, `.bin`→Data, `.txt/.html/.sql`→Text) — used by SvelteKit and Next.js,
  whose final bundles live on disk rather than in Vite's in-memory `writeBundle`.
- The **`Framework` service contract** every integration implements:

```ts
export class Framework extends Context.Service<Framework, {
  readonly build: (options?: FrameworkBuildOptions) => Effect.Effect<BuildOutput, FrameworkError>;
  readonly dev: (options?: FrameworkDevOptions) =>
    Effect.Effect<{ url: string }, FrameworkError, Scope.Scope>;
  readonly readBuildOutput: () => Effect.Effect<BuildOutput, PlatformError>;
}>()("@distilled.cloud/framework-core/Framework") {}
```

Each framework package exports a concrete `Layer<Framework>` (plus its own richly-typed
service if needed). `Vite.ts` in e2e is refactored to be the first implementor.
`build` always persists `dist/build.json` so preview/`Server.live` stays uniform.

### 1.2 e2e harness generalization

- `Options` (`packages/tools/e2e/src/Options.ts`) gains
  `framework?: Layer<Framework>` (default: the existing `ViteLive` with `options.vite`).
- `Server.dev()` dispatches to `Framework.dev` instead of hardcoding `vite.dev`.
- `Server.live()` is already framework-agnostic (miniflare over `dist/build.json` +
  `clientDirectory`) — unchanged. Miniflare stays the preview-parity engine; workerd via
  cloudflare-runtime stays the dev engine (except Next, whose dev v1 **is** cloudflare-runtime,
  see §2.4).
- Fix the stale `./Harness` export while touching the package.

---

## 2. Per-framework design

### 2.1 Waku — `@distilled.cloud/waku`

**Path:** existing cloudflare-vite-plugin, RSC topology. Mostly configuration.

- **Upstream APIs:** `unstable_combinedPlugins` (`waku/vite-plugins`) +
  `unstable_resolveConfig` (`waku/internals`) composed into `vite.createServer` /
  `vite.createBuilder(...).buildApp()` — exactly what the waku CLI does. Before
  `buildApp()`, set `globalThis.__WAKU_START_PREVIEW_SERVER__ = () => vite.preview({...})`
  (SSG hard-requires it).
- **Wrangler decoupling:** fork `waku/adapters/cloudflare.ts` (~200 lines, built on public
  `waku/adapter-builders`) as `@distilled.cloud/waku/adapter`, dropping
  `buildEnhancers: ['waku/adapters/cloudflare-build-enhancer']` — the sole wrangler-file
  writer. Select via in-memory `Config.unstable_adapter`; add a resolve alias mapping
  `waku/adapters/cloudflare` → our fork for users who import it directly. All wrangler.jsonc
  content becomes plugin options: `compatibilityDate`, `compatibilityFlags: ["nodejs_als"]`,
  `worker.{name,bindings,assets}`.
- **Dev:** our vite plugin with `viteEnvironments: { entry: "rsc", children: ["ssr"] }`
  (proven by `fixtures/react-router-rsc`). **Must pass `main` explicitly**
  (`waku/dist/lib/vite-entries/entry.server.js`) because waku's rsc env has two inputs
  (`index` + `build`) and our dev plugin asserts exactly one. Bindings via
  `import { env } from 'cloudflare:workers'` — no proxy machinery needed.
- **BuildOutput:** the shared collector as-is — `serverModules[0] = server/index.js`
  (rsc entry), `clientDirectory = dist/public` (includes SSG HTML/RSC payloads, captured
  as a path so post-writeBundle SSG files ride along). Optionally re-read pruned server
  chunks from disk post-build (waku's prune step rewrites files after `writeBundle`).
- **Riskiest unknown (prototype first):** input merging — our `optionsPlugin` setting
  `rollupOptions.input` on the rsc env must not clobber waku's extra `build` input, or SSG
  breaks ("cannot find dist/server/build.js"). We own the plugin; worst case is a
  "preserve existing inputs" tweak.

### 2.2 Astro — `@distilled.cloud/astro`

**Path:** vite-plugin path, entered through astro's programmatic API.

- **Upstream APIs:** `import { dev, build, sync } from 'astro'` with `AstroInlineConfig`
  (`configFile: false`, `root`, `server.port`, `adapter`, `vite.plugins`). `dev()` returns
  `{ resolvedUrls, stop }` → `acquireRelease`; `build()` runs
  `vite.createBuilder(...).buildApp()` internally, so our collector plugin is injected via
  `AstroInlineConfig.vite.plugins`.
- **Integration fork:** fork `packages/integrations/cloudflare/src/index.ts` (~530 lines,
  mostly deletions) as `distilledCloudflare(options)`:
  - swap `cfVitePlugin` → `cloudflareVitePlugin({ main: '@astrojs/cloudflare/entrypoints/server',
    viteEnvironments: { entry: 'ssr' }, compatibilityDate, compatibilityFlags: ['nodejs_compat'],
    worker: { bindings, assets }, context })`. Astro pins `viteEnvironment 'ssr'` (our default)
    and already steps around a non-runnable ssr env in dev.
  - **reuse verbatim** the wrangler-free runtime (`@astrojs/cloudflare/entrypoints/server`,
    `utils/handler|cf|cf-helpers`), `vite-plugin-config.ts` (`virtual:astro-cloudflare:config`),
    the `optimizeDeps.include` env plugin, `cf-imports`/`cf-externals`,
    `_headers`/`_redirects` post-processing.
  - **drop** `loadWranglerEnv`, wrangler-config watchers, `previewEntrypoint`, the
    output-wrangler.json patch, and the workerd prerenderer — phase 1 hardwires the
    adapter's own `prerenderEnvironment: 'node'` path.
  - **defaults changed:** `imageService: 'compile'` (IMAGES binding is remote-only in our
    runtime), sessions disabled unless the user opts in (KV local plugin lands later).
- **Wrangler decoupling:** the wrangler.json replacement is exactly what
  `cloudflareConfigCustomizer` synthesizes today (`main`, `compatibility_date`, ASSETS/
  SESSION/IMAGES bindings) — expressed as our plugin options + alchemy Worker props.
- **Dev:** astro `dev()` → our plugin's workerd module-runner runs the `ssr` env; astro's
  node-runnable `astro` helper env is left alone (our plugin only maps configured names).
- **BuildOutput:** collector with `entryEnvironment: 'ssr'`, `skipEnvironments: ['prerender']`.
  `serverModules[0] = entry.mjs`; `clientDirectory = dist/client` (prerendered HTML written
  post-vite-build rides along as a path).
- **Riskiest unknown (spike):** dev `ASSETS` binding — `handler.ts` unconditionally calls
  `env.ASSETS.fetch` on 404 fallback; upstream proxies ASSETS to the vite dev server. Our
  runtime's `ViteAssets` plugin already loops HTML lookups back into vite — verify it
  satisfies the fetcher shape, else ship a dev shim fetcher.

### 2.3 SvelteKit — `@distilled.cloud/sveltekit`

**Path:** Vite-driven, but our own kit `Adapter` + post-adapt rolldown pass. Do **not**
force kit's ssr env through our vite plugin (kit enforces `target: 'node22'` and dev SSR
is hardwired to Node `ssrLoadModule`; even Cloudflare's official plugin doesn't fight this).

- **Upstream APIs:** public Vite API only — `vite.createServer({ plugins: [await
  sveltekit(kitConfig)] })` / `vite.createBuilder(...).buildApp()`. Kit v3 takes config
  in-memory via `sveltekit(config)` (on-disk `svelte.config.js` is a hard error), so the
  adapter instance is injected programmatically.
- **Adapter fork:** `distilledCloudflareAdapter(options)` — MIT fork of
  `packages/adapter-cloudflare/index.js` minus wrangler (~150 surviving lines):
  always Workers mode; `dest`/`assetsBinding`/`notFoundHandling` become plain options;
  reuse `builder.writeClient/writePrerendered/generateManifest`, the `src/worker.js` shim
  (prebuilt in our package with the same rolldown config; replace `worktop/cfw.cache`
  with a small `caches.default` wrapper to drop the dep), `_headers`/`_redirects`,
  `.assetsignore`, `builder.instrument`. Drop `unstable_readConfig`, Pages mode,
  `_routes.json`, `getPlatformProxy`.
- **Final bundle pass (replaces `wrangler deploy`'s bundling):** `adapt()` records paths;
  the service then runs programmatic rolldown over `_worker.js` with
  `@distilled.cloud/cloudflare-rolldown-plugin` (workerd conditions,
  `external: ['cloudflare:workers']`), inlining `manifest.js` + the whole
  `.svelte-kit/output/server` graph. Emitted entry-first chunks = `serverModules`.
- **Dev:** kit's Node SSR (full HMR) + our adapter's `emulate()`:
  - Phase 1 (ships now): stub `platform = { env: vars + stub ASSETS fetcher, ctx, caches, cf }`,
    keeping upstream's prerender-env-guard.
  - Phase 2: the shared Node-side bindings proxy (§3.3) backs `env`/`caches`/`cf` with real
    cloudflare-runtime bindings.
- **BuildOutput:** `clientDirectory = .svelte-kit/cloudflare` (client + prerendered +
  `_headers`/`_redirects`/`.assetsignore`); `serverModules` from the rolldown pass
  (disk-read via framework-core helper); `externalWorkspaces` from the pass's module ids.
- **Riskiest unknown (spike):** re-bundling kit's node-flavored (`node22` conditions) server
  output for workerd — wrangler does this today, so it's known-possible, but our rolldown
  pass must match its alias/condition behavior. Prototype with a real app pulling
  node-resolved deps before committing to the adapter surface.

### 2.4 Next.js — `@distilled.cloud/nextjs`

**Path:** bespoke build orchestration + cloudflare-runtime serving. **Decision: reuse the
`@opennextjs/cloudflare` pipeline** (pinned) rather than building a worker from Next's new
`NextAdapter` API — OpenNext's patch corpus is years of workerd-compat work we should not
re-do. The `NEXT_ADAPTER_PATH`/`onBuildComplete` route is the documented fallback if the
deep-import surface churns unacceptably.

- **Build:** call `build(options, config, projectOpts, wranglerConfig, allowUnsupported)`
  from `dist/cli/build/build.js` via pinned absolute-file-URL deep import (or vendor the
  two thin `compileConfig`/`getNormalizedOptions` wrappers to shed cwd/TTY coupling).
  Pass a 2-field in-memory `Unstable_Config` stand-in
  `{ compatibility_date, assets: { run_worker_first: true } }` — the pipeline then runs
  with zero wrangler code. Run in a **disposable child process of our own runner module**
  (upstream can `process.exit(1)` and reads `process.cwd()` at module scope; `next build`
  is spawned internally regardless).
- **Final bundle pass (replaces wrangler's implicit finishing step):** rolldown/esbuild over
  `.open-next/worker.js` resolving the relative imports (`cloudflare/*.js`,
  `middleware/handler.mjs`, `.build/durable-objects/*.js`) and keeping the dynamic
  `import("./server-functions/default/handler.mjs")` a **lazy chunk**; `.wasm`/`.bin`
  externals become proper CompiledWasm/Data modules (our `additionalModulesPlugin` rules).
- **Wrangler decoupling:** drop `preview`/`deploy`/`upload`/`ensure-r2-bucket` entirely
  (alchemy owns provisioning + upload). Reimplement `populateCache` against the distilled
  SDK (remote R2/KV/D1; the D1 DDL is plain SQL) and cloudflare-runtime local storage
  (dev), reusing `getCacheAssets`/`computeCacheKey` from the exported `dist/api` surface;
  `static-assets` cache is a plain `cp` into `assets/cdn-cgi/_next_cache`.
- **Dev v1 (preview-parity, ships with build):** run the final bundle in
  `Runtime.start({ modules, assets: { directory: '.open-next/assets', runWorkerFirst: true },
  bindings, durableObjectNamespaces })` with the three DO classes declared on the same
  script, `WORKER_SELF_REFERENCE` as a self service binding, and cache bindings per the
  chosen config. Watch + rebuild = coarse reload; no HMR (parity with upstream `preview`).
- **Dev v2 (HMR, phase 2):** keep `next dev`; replace `initOpenNextCloudflareForDev`'s
  `getPlatformProxy` with the shared Node-side bindings proxy (§3.3) honoring the tiny
  upstream contract (`globalThis[Symbol.for("__cloudflare-context__")]` + the
  `vm.runInContext` patch, copyable verbatim).
- **BuildOutput:** `clientDirectory = .open-next/assets`; `serverModules` = final-pass
  chunks entry-first (+ wasm companions), disk-read; `externalWorkspaces` mostly empty
  (OpenNext copies traced files into `.open-next`).
- **Riskiest unknowns (prototype FIRST, before any package scaffolding):**
  1. the final bundle pass producing a worker that actually boots in cloudflare-runtime;
  2. runtime gaps it exposes — Images binding emulation (miniflare has a transformer to
     port), self service binding on the same script, SQLite-backed DOs;
  3. deep-import stability across `@opennextjs/cloudflare` releases (pin + e2e).

---

## 3. cloudflare-runtime workstreams

These are shared infrastructure, sequenced against the framework needs:

1. **Self service binding + same-script DOs verification** (needed by Next dev v1) —
   likely already expressible via workerd config; verify with a test, small.
2. **Images binding local emulation** (Next `/_next/image`; Astro `cloudflare-binding`
   image service later) — port miniflare's basic transformer as a local plugin per the
   AGENTS.md binding recipe. Medium.
3. **Node-side bindings proxy** (the `getPlatformProxy` replacement; phase 2) — a
   miniflare-style "magic proxy": boot workerd with the requested bindings + a proxy
   worker, expose Node-side `env`/`caches`/`cf` objects over loopback RPC. Unblocks
   SvelteKit real dev bindings and Next dev v2. This is the largest single piece of new
   runtime engineering — schedule it as its own workstream, not on any framework's
   critical path.
4. **Local KV plugin** (Astro sessions default) — nice-to-have; until then sessions stay
   opt-in with a remote KV binding.

---

## 4. Fixtures + e2e test matrix

One fixture per framework under `fixtures/`, following §4 of
[internals-cloudflare-tools.md](./internals-cloudflare-tools.md) exactly
(scripts `dev/build/preview/test`, shared playwright.config, `e2e.config.ts` default-exporting
`Options.make`, snapshots in `test/__snapshots__`):

| Fixture | App shape | Coverage |
|---|---|---|
| `fixtures/waku` | fs-router pages, one server function reading a `Text.local` binding via `cloudflare:workers`, one static-prerendered page, an SSG page, client nav | SSR + RSC payloads + SSG-in-assets + binding |
| `fixtures/astro` | one SSR page (`export const prerender = false`), one prerendered page, an API endpoint reading `env` binding, an image in `public/` | SSR + prerender + ASSETS fallback + binding |
| `fixtures/sveltekit` | SSR `+page.server.ts` load using `platform.env` binding, a prerendered route, `_headers` file, form action | SSR + prerender + platform emulation + final-bundle fidelity |
| `fixtures/nextjs` | App-router page (nodejs runtime), one edge middleware, one ISR page, an API route reading `getCloudflareContext().env`, static asset | the OpenNext long tail: middleware, ISR/caching, bindings |

Test matrix per fixture: the standard `for (mode of SERVER_METHODS) // ["live","dev"]`
loop — screenshot smoke + `server.fetchJson` API assertions. `live` = miniflare over
`dist/build.json` for all four (the fixture's `miniflare` options half declares DOs/self
bindings for Next). `dev` = the framework's `Framework.dev`:
Waku/Astro → workerd module runner (HMR), SvelteKit → Node SSR + emulate stub,
Next v1 → cloudflare-runtime preview (gate any dev-only HMR assertions per framework).
Next fixture additionally asserts an ISR revalidation round-trip and a middleware rewrite
via plain HTTP.

---

## 5. Alchemy phase — `Cloudflare.Website.<Framework>`

Files per framework (per [internals-alchemy-website.md](./internals-alchemy-website.md) §6 —
no `Providers.ts` change; composites over `Worker`, class-form via `effectClass`):

```
packages/alchemy/src/Cloudflare/Website/{Waku,Astro,SvelteKit,Nextjs}.ts  (+ barrel export)
packages/alchemy/test/Cloudflare/Website/{Framework}.test.ts + {framework}-fixture/
examples/cloudflare-{waku,astro,sveltekit,nextjs}/     (cloudflare-nextjs placeholder exists)
```

Resource shapes:

- **`Website.Waku`** — rides the existing `WorkerProps.vite` path like `Website.Vite`:
  sets `viteEnvironments: { entry: "rsc", children: ["ssr"] }` and injects
  `unstable_combinedPlugins(resolveConfig({ unstable_adapter: "@distilled.cloud/waku/adapter" }))`
  plus the preview-server global. Requires one small extension to the internal
  `ViteOptions`: `plugins?: () => Promise<PluginOption[]>` (a lazy plugin injector) so the
  composite can contribute framework plugins without a user `vite.config.ts`. Dev = the
  existing `runVite` path — HMR with real alchemy-managed bindings for free.
  ```ts
  class Site extends Cloudflare.Website.Waku<Site>()("Site", {
    env: { BUCKET: Bucket },
    compatibility: { flags: ["nodejs_als"] },
  }) {}
  ```
- **`Website.Astro`** and **`Website.SvelteKit`** — build via the framework package's
  programmatic `build` (astro's `build()` / kit `buildApp` + rolldown pass), which leaves
  the finished worker **on disk**; then `Worker` with the documented prebuilt contract:
  `{ bundle: false, main: <dist entry>, assets: { directory: <client dir>, hash }, rules }`.
  Implemented as a `Namespace.push(id)` composite: a `FrameworkBuild` step (reusing
  `Command.Build`'s memo/input-hash machinery but invoking the Effect service in-process
  rather than a shell) + `Worker`. Dev phase 1 = `dev: { mode: "external", url }` fronting
  the framework package's `Framework.dev` (Astro gets workerd-with-bindings dev because our
  forked integration accepts `worker.bindings` + `context` — the composite passes alchemy's
  resolved bindings through; SvelteKit gets Node SSR + emulate stubs until the bindings
  proxy lands).
  ```ts
  class Site extends Cloudflare.Website.Astro<Site>()("Site", {
    env: { DB: Database },
    imageService: "compile",
  }) {}
  ```
- **`Website.Nextjs`** — StaticSite-shaped: `@distilled.cloud/nextjs` build (child-process
  orchestration, memoized by input hash) → `Worker` with
  `{ bundle: false, main: ".open-next/dist/worker.js", assets: ".open-next/assets", rules }`
  + DO namespace/migration props for the three OpenNext DO classes + the well-known cache
  bindings (`NEXT_INC_CACHE_*`, `NEXT_TAG_CACHE_*`, `WORKER_SELF_REFERENCE` as a
  self-service binding) synthesized from a `cache?: "r2" | "kv" | ...` prop. Cache
  population runs as a post-upload step inside the composite (idempotent — keys are
  content-addressed per buildId). Dev = `Command.Dev`-style external `next dev` +
  our init module (v2), or cloudflare-runtime preview (v1).

Docs: JSDoc `@resource`/`@product Website` + `@section`/`@example` blocks on each export,
then `bun generate:api-reference`. Tests follow `Vite.test.ts`/`StaticSite.test.ts`
(clone fixtures to `.tmp`, assert input-hash memoization, bounded timeouts, `--profile testing`).

---

## 6. Ordered execution plan

**Phase 0 — spikes (1 week, parallelizable; do these before any package scaffolding):**
1. **S-Next (riskiest overall):** hand-run `@opennextjs/cloudflare` build on a toy app,
   write a throwaway final-bundle pass, boot the result in `cloudflare-runtime` — inventory
   the runtime gaps (Images, self-binding, DOs). This decides the Next timeline.
2. **S-Waku:** waku dev+build through our vite plugin — verify the two-input merge and the
   preview-server global. Cheapest validation of the whole vite-path thesis.
3. **S-SvelteKit:** rolldown-rebundle a kit `_worker.js` (node-target output → workerd
   conditions) and boot it in miniflare + cloudflare-runtime.
4. **S-Astro:** astro `dev()` with our plugin on the `ssr` env — verify middleware ordering
   and the dev `ASSETS.fetch` fallback against `ViteAssets`.

**Phase 1 — shared scaffolding (few days):**
5. `@distilled.cloud/framework-core`: extract BuildOutput/collector/loaders from e2e
   `Vite.ts`; refactor `Vite.ts` onto it; generalize e2e `Options`/`Server` to the
   `Framework` service. (Blocks all framework packages.)

**Phase 2 — vite-family frameworks (parallel tracks after Phase 1):**
6. `@distilled.cloud/waku` + `fixtures/waku` (~1 wk). First shipper; exercises the
   RSC path end-to-end.
7. `@distilled.cloud/astro` + `fixtures/astro` (~1.5–2 wk). Depends on S-Astro outcome
   for the dev-ASSETS approach.
8. `@distilled.cloud/sveltekit` + `fixtures/sveltekit` (~1.5–2 wk). Depends on S-SvelteKit;
   dev ships with Phase-1 emulate stubs.

**Phase 3 — runtime workstream (parallel with Phase 2):**
9. cloudflare-runtime: self-service binding + same-script DO verification (small),
   Images local emulation (medium). Both gate Next dev v1, not the vite-family tracks.

**Phase 4 — Next.js (~4–6 wk, starts once S-Next lands; overlaps Phase 2):**
10. `@distilled.cloud/nextjs`: build orchestration + final bundle pass + populateCache
    reimplementation + dev v1 (cloudflare-runtime preview) + `fixtures/nextjs`.

**Phase 5 — alchemy resources (per framework, as each cloudflare-tools package goes green):**
11. `Website.Waku` → `Website.Astro` → `Website.SvelteKit` → `Website.Nextjs`, each with
    fixture-clone tests + example project; bump the cloudflare-tools submodule per landing.

**Phase 6 — fidelity (backlog, scheduled after everything above ships):**
12. Node-side bindings proxy in cloudflare-runtime → SvelteKit real dev bindings +
    Next dev v2 (HMR) + OpenNext `initOpenNextCloudflareForDev` replacement.
13. Astro workerd prerendering (reimplement the small HTTP prerender protocol over
    cloudflare-runtime); local KV plugin (Astro sessions default on).

**Version pinning policy (applies to all four):** every upstream surface we touch is
`@experimental`/`unstable_`/unexported — pin exact framework versions in the package
`peerDependencies`/`devDependencies`, e2e-test against real apps in CI, and treat version
bumps as deliberate migrations, not routine updates.

## Amendment (2026-07-20): platform proxy policy

Maintainer guidance: wherever an upstream integration uses wrangler's
`getPlatformProxy` (SvelteKit `adapter-cloudflare`, OpenNext
`initOpenNextCloudflareForDev`, Astro `platformProxy`), the fix is to
**reimplement the feature in `@distilled.cloud/cloudflare-runtime`**
(workerd-backed Node-side proxies for env/cf/ctx/caches, configured
in-memory) — never to take a wrangler dependency. This promotes the
"Node-side bindings proxy" from Phase 6 backlog to a scheduled
workstream: it unblocks SvelteKit real dev bindings, Next dev v2 (HMR),
and Astro dev parity.
