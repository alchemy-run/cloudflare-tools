# Spike: Waku on the cloudflare-vite-plugin path

Verdict: **proved, with caveats** — the whole loop (programmatic build → BuildOutput →
miniflare preview → workerd dev with HMR) works with zero wrangler artifacts, but the
spike surfaced one hard plugin-ordering requirement for dev, two collector gaps that make
the raw `dist/build.json` non-bootable for waku, and confirmed the SSG-in-Node limitation.

Fixture: `fixtures/spike-waku/` (waku `1.0.0-beta.7` pinned, vite `catalog:` = 8.1.4,
final state = **managed mode** — no `waku.server.tsx`, adapter selected via in-memory
`unstable_adapter`; the explicit `src/waku.server.tsx` variant was also proven mid-spike).

## What was run

```sh
cd fixtures/spike-waku
bun run build                 # e2e build → vite.createBuilder(...).buildApp() + SSG
bun scripts/fix-build-json.ts # spike stand-in for readServerModulesFromDisk (see gap 2)
bun run preview               # e2e preview → miniflare over dist/build.json
bun scripts/dev.ts            # vite.createServer with our plugin in waku's config.vite.plugins
```

Assertions (all passing in the final state):

- preview `GET /` (dynamic page) → SSR HTML with `MAX_ITEMS=10` read from the
  `Text.local("MAX_ITEMS", "10")` binding via `import('cloudflare:workers')` inside miniflare.
- preview `GET /about` → 200 SSG HTML served from assets (`dist/public/about/index.html`);
  `GET /RSC/R/about.txt` → 200 (SSG RSC payload).
- dev `GET /` → SSR from **workerd** with `MAX_ITEMS=10` (proves the rsc env runs in
  workerd — the guarded `cloudflare:workers` import resolved).
- dev hot update: editing `src/pages/about.tsx` marker → next request serves the new
  content without a server restart (module-runner transform path live).
- `find . -name 'wrangler*'` (excluding node_modules) → **0 files**; no `.wrangler/` dir;
  nothing reads a wrangler config at any point.

## Composition that works

Build (via the e2e harness, `Vite.ts` appending `cloudflareVitePlugin` after config-file
plugins — fine for build, NOT for dev, see finding 3):

- `vite.config.ts` builds the waku config in memory:
  `resolveConfig({ unstable_adapter: <abs path to src/adapter.cloudflare.ts>, vite: { environments: { rsc: { optimizeDeps.include: ['hono/tiny'] }, ssr: { optimizeDeps.include: ['waku > rsc-html-stream/server'] } } } })`
  and default-exports `plugins: [combinedPlugins(wakuConfig)]`.
- It also sets `process.env.NODE_ENV ??= command === 'build' ? 'production' : 'development'`
  (the waku CLI does this; waku's environmentsPlugin bakes `process.env.NODE_ENV` into
  `define`, and the e2e CLI sets neither) and, for build only,
  `globalThis.__WAKU_START_PREVIEW_SERVER__ = () => vite.preview({ configFile: false, plugins: [combinedPlugins(wakuConfig)] })`.
- `e2e.config.ts`: `main = <waku pkg dir>/dist/lib/vite-entries/entry.server.js`
  (resolved via `require.resolve('waku/package.json')` — the deep path is NOT in waku's
  exports map, so resolve the package dir and join),
  `viteEnvironments: { entry: 'rsc', children: ['ssr'] }`,
  `compatibilityFlags: ['nodejs_als']` (sufficient — R6 confirmed), worker bindings +
  mirrored miniflare options with `html_handling: 'drop-trailing-slash'`.

Dev (`scripts/dev.ts`): identical waku config, but `cloudflareVitePlugin({ ... })` is
placed **inside `wakuConfig.vite.plugins`** and the server is created with
`vite.createServer({ configFile: false, plugins: [combinedPlugins(wakuConfig)] })` —
the exact position upstream documents for `@cloudflare/vite-plugin`.

## Findings

### 1. THE RISK — rollupOptions.input merging: NOT clobbered (R2 disproven)

Waku's rsc env declares `input: { index: entry.server.js, build: entry.build.js }`; our
optionsPlugin sets `input: { 'entry.server': '\0distilled:worker-entry:<main>' }` on the
entry env. Vite's `mergeConfig` merges the records key-wise, so the built rsc env has
**three** inputs and emits `dist/server/index.js`, `dist/server/entry.server.js` and
`dist/server/build.js`. The SSG step (`staticBuildPlugin` importing
`<rsc outDir>/build.js`) found its file; `[ssg] processing static generation... ✓ 3 files
generated`, `[prune] removed static-only 4 chunk(s)`. No "cannot find dist/server/build.js".

Side effects to handle in the real package:

- Duplicate worker-entry facades: `index.js` (waku's input) and `entry.server.js` (our
  wrapped main) are both ~0.5 kB re-export facades of the same shared chunk — harmless.
- **Entry-pick nondeterminism in the collector**: `Vite.ts`'s output plugin records
  `serverEntry` for *any* `isEntry` chunk of the entry environment, last-iterated wins.
  With three entry chunks it happened to record `server/index.js` (a correct main —
  default export is the adapter's `ExportedHandler`), but it could equally have recorded
  `build.js`, which would put a non-worker module at `serverModules[0]`. Entry detection
  must be pinned (e.g. match the chunk whose facade is the wrapped `\0distilled:worker-entry:`
  id, falling back to the env input named by the plugin).

### 2. BuildOutput contract: shape is right, but two collector gaps make it non-bootable

`dist/build.json` after `e2e build`: `clientDirectory = dist/public` (SSG HTML +
`RSC/R/*.txt` payloads ride along as directory contents — as designed),
`serverModules` entry-first with `server/index.js` at [0], `externalWorkspaces` empty.

But the first `e2e preview` failed to boot:

```
service core:user:: Uncaught Error: No such module "server/__waku_build_metadata.js".
  imported from "server/assets/server-entry-BeTmZIk6.js"
```

- **Gap (a) — post-writeBundle disk files.** waku's `buildMetadataPlugin` marks
  `virtual:vite-rsc-waku/build-metadata` external, `renderChunk` rewrites it to a
  relative import of `__waku_build_metadata.js`, and the file is only written during
  `buildApp` hooks (stub first, real content after SSG via `handler.ts`). The collector's
  in-memory `writeBundle` capture never sees it — same genus as the `@vitejs/plugin-rsc`
  manifests that `Vite.ts` already special-cases, but framework-specific.
- **Gap (b) — pruning staleness (R5 confirmed).** After SSG, waku stubs static-only
  server chunks on disk (`// Pruned by Waku - content cached at build time.`, 50 bytes)
  while `build.json` holds the pre-prune contents (547/813 bytes). Functionally correct,
  just uploads dead code.

Both are fixed at once by re-reading the server outDir from disk after `buildApp`
resolves — exactly the `readServerModulesFromDisk` helper PLAN §1.1 proposes.
`scripts/fix-build-json.ts` in the fixture is that helper as a spike stand-in; with it
applied, the same `e2e preview` boots and serves everything.

### 3. Dev plugin ordering is a hard requirement (R3 confirmed, with the fix)

Appending `cloudflareVitePlugin` **after** `combinedPlugins` (what the e2e harness's
`Vite.dev` does today: `plugins: [...config.plugins, cloudflareVitePlugin(...)]`) breaks
dev: every request 500s with

```
Cannot read properties of undefined (reading 'import')
    at waku/dist/lib/vite-plugins/environments.js:126:62
```

Root cause: `configureServer` post-middlewares register in plugin order. Waku's
`environments` plugin registers its Node request bridge
(`(server.environments.rsc as RunnableDevEnvironment).runner.import(entryId)`) before our
workerd proxy, and `DistilledDevEnvironment` has no `.runner`. Upstream never hits this
because `@cloudflare/vite-plugin` is passed through `config.vite.plugins`, which waku's
`extraPlugins` places **first** in `combinedPlugins` — ahead of its own environments
plugin. Injecting our plugin the same way (dev script) fixes it: our proxy middleware
runs first and waku's bridge never fires.

Alternative fix we own (worth considering so harness-style "append last" also works):
make `dev-plugin.ts` register its proxy middleware ahead of other post-middlewares
(e.g. register during `configureServer`'s synchronous phase instead of the returned
callback, or unshift onto `server.middlewares.stack`).

### 4. Wrangler decoupling: fully proven

- `src/adapter.cloudflare.ts` is a ~200-line fork of `waku/adapters/cloudflare` built
  only on public `waku/adapter-builders` + `waku/internals` exports, with the single
  functional change `buildEnhancers: []` (upstream:
  `['waku/adapters/cloudflare-build-enhancer']` — the sole wrangler-file writer in waku).
- Accepted in **both** selection modes:
  - explicit: `src/waku.server.tsx` importing the fork directly (proven mid-spike);
  - managed (final fixture state): in-memory `Config.unstable_adapter` set to the fork's
    absolute path; waku's generated server entry imports `'waku/adapters/default'` and
    `adapterAliasPlugin` resolves it to the fork (verified via `fetchModule`:
    `/src/adapter.cloudflare.ts` appears in the transformed managed entry).
- Zero wrangler files written or read across build, preview and dev.
- **Footgun found**: if `unstable_adapter` is omitted in managed mode (and neither
  `CLOUDFLARE` nor `WORKERS_CI` env is set), `getDefaultAdapter()` silently picks
  `waku/adapters/node`, which cannot run inside workerd — every dev request 500s with an
  opaque `Internal Server Error`. The package must always pin `unstable_adapter`.

### 5. SSG under programmatic buildApp: works, renders in Node (R4 confirmed)

Setting `globalThis.__WAKU_START_PREVIEW_SERVER__` (vite.preview + `combinedPlugins`,
`configFile: false`) before `builder.buildApp()` is sufficient: the adapter's fallback
middleware streams the SSG multiplex and `dist/public/about/index.html` +
`dist/public/RSC/R/about.txt` are emitted; prune runs.

Caveat (upstream-parity limitation, not a regression): SSG rendering happens **in Node**,
so a page with a *top-level* `import { env } from 'cloudflare:workers'` kills the build:

```
Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file, data, and node
are supported by the default ESM loader. Received protocol 'cloudflare:'
```

(waku imports every page module during SSG to read `getConfig`, even dynamic-render
pages). Workaround used by the fixture and by waku's own adapter: guarded dynamic import.
Full parity fix (later): implement preview support so `__WAKU_START_PREVIEW_SERVER__`
serves the freshly built worker via cloudflare-runtime/workerd — upstream's
`@cloudflare/vite-plugin` achieves exactly this via `configurePreviewServer`.

### 6. Misc operational findings

- `main` **must** be passed explicitly (dev plugin asserts exactly one entry; waku's rsc
  env has two inputs). `waku/dist/lib/vite-entries/entry.server.js` is not reachable via
  waku's exports map — resolve `waku/package.json` and join.
- `nodejs_als` alone is enough for waku core in workerd (dev + miniflare preview).
- `process.env.NODE_ENV` must be set before waku's plugin `config()` hooks run.
- Worker-side failures in dev surface as an opaque `Internal Server Error` (the Loopback
  invoke bridge's catch-all) with **no Node-side log of the cause** — painful DX; worth
  propagating the cause in `LoopbackServer`/dev-plugin.
- bun's `minimumReleaseAge = 3 days` nearly blocked `waku@1.0.0-beta.7` (published 3 days
  + 3 h before the spike). Framework pins for the real packages must respect this gate.

## Implications for `@distilled.cloud/waku`

1. Composition = `resolveConfig({ unstable_adapter: <our fork>, vite: { plugins: [cloudflareVitePlugin(opts)], environments: {rsc/ssr optimizeDeps} } })`
   → `createServer/createBuilder({ configFile: false, plugins: [combinedPlugins(config)] })`.
   The cloudflare plugin goes **inside waku's config.vite.plugins**, not appended after —
   or the dev-plugin middleware ordering is fixed first (we own it).
2. Ship the adapter fork as `@distilled.cloud/waku/adapter` (this spike's
   `src/adapter.cloudflare.ts` is the fork, minus nothing else); always set
   `unstable_adapter`; optionally alias `waku/adapters/cloudflare` → fork for users who
   import it explicitly.
3. framework-core's collector needs: (a) post-`buildApp` disk re-read of server modules
   (build metadata + pruned chunks), (b) deterministic entry-chunk selection.
4. Set `__WAKU_START_PREVIEW_SERVER__` before `buildApp`; document the SSG-in-Node
   limitation; schedule workerd-backed preview as the parity enhancement.
