# Spike S-Next: Next.js end-to-end (OpenNext build → final bundle → cloudflare-runtime boot)

**Verdict: PROVED (with caveats).** A Next 16.2.10 app-router app (SSR page, API route,
ISR page, edge middleware, static assets) builds through `@opennextjs/cloudflare@1.20.1`'s
build pipeline invoked programmatically (no wrangler binary, no wrangler.json), gets
finished into a self-contained module set by a ~60-line esbuild pass, and boots in
`@distilled.cloud/cloudflare-runtime` (workerd) with **11/11 HTTP checks passing** —
including the memory-queue ISR revalidation path over `WORKER_SELF_REFERENCE` and a
SQLite-backed same-script Durable Object (`DOQueueHandler`) invoked over JS RPC.

Fixture: [`fixtures/spike-nextjs/`](../../fixtures/spike-nextjs/). Reproduce:

```sh
cd fixtures/spike-nextjs
node scripts/run-opennext-build.mjs   # OpenNext pipeline (spawns `next build` internally)
node scripts/bundle.mjs               # final bundle pass -> dist-worker/ (+ cache -> assets/cdn-cgi/_next_cache)
bun scripts/serve.ts                  # boot in cloudflare-runtime + run HTTP assertions
SPIKE_DEBUG=1 bun scripts/serve.ts    # + error-surfacing wrapper entry + SQLite DO probe route
```

Final output (non-debug):

```
PASS  ssr page /                          status=200 hasMarker=true
PASS  api route /api/hello                status=200 json={"hello":"world",...}
PASS  static asset /static.txt            status=200
PASS  _next/static asset                  status=200
PASS  isr page first hit                  status=200 x-nextjs-cache=STALE stamp=<prerender>
PASS  isr page after revalidate window    status=200 x-nextjs-cache=STALE (read-only cache: stamp unchanged, expected)
PASS  isr page third hit                  status=200
PASS  middleware rewrite /mw-rewrite      status=200 rewrote=true
PASS  middleware header on /api/hello     x-spike-middleware=passed
PASS  images probe /_next/image           status=400 (informational; no IMAGES binding)
[+ debug] sqlite DO queue probe           status=200 {"ok":true}
```

---

## 1. BUILD — programmatic pipeline, wrangler-free (PROVED)

What ran ([`scripts/run-opennext-build.mjs`](../../fixtures/spike-nextjs/scripts/run-opennext-build.mjs),
executed as its own disposable `node` process, cwd = app root):

- **Did NOT import `dist/cli/commands/utils/utils.js`** — that module imports
  `unstable_readConfig` from `wrangler` at module scope. Instead the two thin wrappers
  were reimplemented (~15 lines total):
  - `compileConfig` ≈ `compileOpenNextConfig(configPath, { compileEdge: true })`
    (from `@opennextjs/aws/build/compileConfig.js`) + `ensureCloudflareConfig`
    (deep import `dist/cli/build/utils/ensure-cf-config.js` — no wrangler in its graph).
  - `getNormalizedOptions` ≈ `normalizeOptions(config, dirname(resolve("@opennextjs/aws/index.js")), buildDir)`.
- **Deep import** of `dist/cli/build/build.js` → `build(options, config, projectOpts, wranglerConfig, false)`.
  Resolution note: the exports map doesn't expose `./package.json`, so resolve the `"."`
  entry (`dist/api/index.js`) and walk up two directories to find the package root.
- `open-next.config.ts` on disk (required; `compileOpenNextConfig` esbuilds it):
  `defineCloudflareConfig({ incrementalCache: staticAssetsIncrementalCache, queue: memoryQueue })` —
  fully local, no KV/R2/D1 needed.

### The minimal wrangler-config stub (captured, exhaustive)

The pipeline consumes exactly **two** fields of the `Unstable_Config`:

```js
const wranglerConfig = {
  compatibility_date: "2026-05-12",          // build.ts:57-70 — staleness warning only
  assets: { run_worker_first: true },        // compile-init.ts:33 — __ASSETS_RUN_WORKER_FIRST__ define
};
```

Everything else in the pipeline is esbuild + `@opennextjs/aws` + `@ast-grep/napi` + fs.

### Caveats found on the build path

1. **`ensureNextjsVersionSupported` (dist/cli/utils/nextjs-support.js:15) does
   `await import("wrangler/package.json", { with: { type: "json" } })` unconditionally** —
   the wrangler *package* must be resolvable from `@opennextjs/cloudflare` (it is, as a
   non-optional peerDependency every package manager installs; bun's isolated linker put
   `wrangler@4.112.0` in the store). Only the JSON is read (a version-comparison warning);
   **no wrangler code executes**. A purist package can vendor/patch this one function.
   Audit of runtime `wrangler` imports in `dist/cli/**`: only `commands/populate-cache.js`,
   `commands/utils/utils.js`, `commands/utils/helpers.js` — none on our path.
2. **`buildNextjsApp` runs the app's `build` script** (`bun run build` here) — the app
   package.json needs `"build": "next build"` (or set `config.buildCommand`). Error
   otherwise: `error: Script not found "build"`.
3. Next 16.2.10 + Turbopack build worked unmodified; `next build` is spawned by the
   pipeline (unavoidable, ~10s for the toy app).
4. Upstream can `process.exit(1)` (Node middleware check) and prompts on TTY only in the
   *command* wrapper we bypass — running the runner as a child process remains the right
   containment.
5. Monorepo detection ("Monorepo detected at <repo root>") worked; output landed in
   `fixtures/spike-nextjs/.open-next/`.

## 2. FINAL BUNDLE — the step wrangler normally performs (PROVED)

[`scripts/bundle.mjs`](../../fixtures/spike-nextjs/scripts/bundle.mjs): one esbuild pass
over `.open-next/worker.js` → `dist-worker/` (167ms):

```
worker.js                          377 KiB   (entry: init + images + skew + middleware, incl. middleware/handler.mjs)
chunks/handler-*.js               3.9 MiB   (lazy: server-functions/default/handler.mjs — dynamic import preserved)
chunks/open-next.config-*.js       13 KiB
chunks/chunk-*.js                  0.7 KiB  (shared)
```

Config that made it work:

- `bundle: true, format: "esm", splitting: true, platform: "node", conditions: ["workerd", "worker"]`,
  `external: ["cloudflare:*", "node:*"]`. Splitting keeps the upstream-load-bearing
  `await import("./server-functions/default/handler.mjs")` a **lazy chunk**.
- **`createRequire` banner (the critical fix).** Without it every dynamic route 500s with
  `Error: Dynamic require of "fs" is not supported` (esbuild's `__require` shim throwing —
  the CJS-converted Next server requires externalized node builtins). Same trick wrangler
  uses, per output file:

  ```js
  import { createRequire as __cr } from "node:module";
  const require = /* @__PURE__ */ __cr(import.meta.url ?? "file:///");
  ```

  The `?? "file:///"` fallback is required: **`import.meta.url` is `undefined` inside
  workerd modules** — plain `createRequire(import.meta.url)` crashes the worker at startup
  (`TypeError: The argument 'path' ... Received 'undefined'` at `node:module createRequire`).
- `.wasm`/`.bin`: OpenNext's `setWranglerExternal` leaves them as **absolute-path**
  imports (optionally `?module`-suffixed) for wrangler. A tiny onResolve plugin strips
  `?module` and routes them into `loader: "copy"`, emitting hashed siblings that get
  registered as `Wasm`/`Data` modules. (The toy app emitted none — **exercise with
  `@vercel/og` before hardening**.)
- populateCache (static-assets flavor) without wrangler = `cpSync(.open-next/cache →
  .open-next/assets/cdn-cgi/_next_cache)` — 3 lines.

`rolldown` + `@distilled.cloud/cloudflare-rolldown-plugin` was not needed for the spike;
esbuild (already a transitive dep of OpenNext) sufficed. The production package can use
either; the rolldown plugin's `additionalModulesPlugin`/nodejs-compat machinery would
subsume the two hand-rolled fixes above.

## 3. BOOT — cloudflare-runtime serves it (PROVED)

[`scripts/serve.ts`](../../fixtures/spike-nextjs/scripts/serve.ts):
`RuntimeServices.layerRuntime({ api: { accountId: "spike-local-account" } })` +
`NodeServices.layer` + `Credentials.fromEnv()` + `FetchHttpClient.layer` (dummy accountId;
credentials never used — bindings are local-only), then:

```ts
runtime.start({
  name: "spike-nextjs",
  compatibilityDate: "2026-05-12",
  compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
  bindings: [
    Assets.local("ASSETS"),
    Effect.succeed({ name: "WORKER_SELF_REFERENCE", service: { name: "user-worker" } }), // hand-rolled
    DurableObjectNamespace.local({ binding: "NEXT_CACHE_DO_QUEUE", className: "DOQueueHandler" }),
  ],
  modules,                                     // dist-worker/*, entry (worker.js) first
  assets: { directory: ".open-next/assets", runWorkerFirst: true },
  durableObjectNamespaces: [{ className: "DOQueueHandler", sql: true }],
});
```

Observed:

- SSR page, API route, `public/` asset, `_next/static` chunk: all 200. Edge middleware
  (compiled into `worker.js` via `middleware/handler.mjs`): rewrite + response-header
  mutation both work.
- ISR: serves the prerendered payload from the read-only static-assets cache
  (`x-nextjs-cache: STALE`; memory-queue revalidation fires a HEAD request through
  `WORKER_SELF_REFERENCE` — the re-render happens, but the write back is rejected by the
  read-only cache, so the payload never updates. **Expected** for this config; full
  revalidation requires a writable incremental cache (see gaps).
- Same-script SQLite DO: `DOQueueHandler` instantiates (SQL DDL in
  `blockConcurrencyWhile`), accepts the `revalidate()` JS-RPC call, and HEAD-fetches the
  worker through the self service binding. `{"ok":true}`.
- `global_fetch_strictly_public` caused no local issues (self-calls go through the
  service binding, not global fetch).

## 4. Runtime gap inventory

| # | Gap | Severity | Detail |
|---|---|---|---|
| 1 | **No local writable KV/R2/D1** → no writable incremental/tag cache in dev | **High** (for ISR/`revalidatePath` parity; the read-only static-assets cache is a working floor) | `KvNamespace`/`R2Bucket`/`D1` are remote-only in cloudflare-runtime. Confirms PLAN §3.4's "local KV plugin" workstream; R2 or KV local storage is the actual unblock for `NEXT_INC_CACHE_*`. Remote bindings would work today for credentialed dev. |
| 2 | **No `Service.self()` helper** for `WORKER_SELF_REFERENCE` | Low (workaround trivial, but it leans on an internal constant) | Hand-rolled `BindingHook` targeting the internal `SERVICE_USER_WORKER` name (`"user-worker"`). Add a public `Service.self(binding)` (or accept `scriptName === worker.name` in `Service.local` without the registry round-trip). Note: it binds the raw user worker, bypassing the assets middleware chain — correct for revalidation; document the semantics. |
| 3 | **Images binding local emulation missing** | Medium | `Images` is remote-only. `cloudflare/images.js` degrades gracefully (`env.IMAGES` undefined → warn + serve original image); `/_next/image?url=/static.txt` returned 400 (non-image input). Parity needs the miniflare transformer port (PLAN §3.2). |
| 4 | **workerd uncaught exceptions are invisible** | Medium (DX) | Worker-thrown errors produce a bare `500 Internal Server Error`; workerd only logs them with `--verbose`, and `Runtime.start` doesn't expose workerd CLI args. Debugging required injecting a wrapper entry module. Add a `verbose`/log-capture option to `Runtime`/`Workerd`. |
| 5 | **`import.meta.url` is `undefined` in workerd modules** | Low (once known) | Any bundle relying on it (our `createRequire` banner, Next internals guarded by fallbacks) must tolerate `undefined`. Worth a note in the final-bundle pass docs. |
| — | Same-script SQLite DOs | **No gap** — worked first try (`sql: true` → `enableSql`) | |
| — | Self service binding (raw workerd config) | **No gap** — worked via hand-rolled hook | |
| — | Workers Assets + `runWorkerFirst` + `ASSETS` fetcher from the worker | **No gap** — asset resolver override's `env.ASSETS.fetch` works against the assets middleware | |

Untested (flagged for the package's e2e matrix): `@vercel/og` (wasm externals), Pages
router, PPR, `revalidatePath`/`revalidateTag` with a writable cache, cache interception,
skew protection, `getCloudflareContext()` in `next dev` (dev-v2 territory), Windows paths.

## 5. Implications for `@distilled.cloud/nextjs`

1. **Green-light the OpenNext-pipeline plan** (PLAN §2.4) as-is. The deep-import surface
   held; pin `@opennextjs/cloudflare` exactly (its `@opennextjs/aws` is already pinned to
   4.0.2). The two `compileConfig`/`getNormalizedOptions` wrappers should be vendored
   (~15 lines) — that is the entire wrangler decoupling, minus one caveat:
2. **wrangler stays in node_modules as an inert peer** (only its `package.json` is read,
   by `ensureNextjsVersionSupported`). Either accept that (document it) or patch that one
   import out. Never spawned, never code-imported.
3. **The final bundle pass is small but has sharp edges** worth centralizing in
   framework-core/rolldown-plugin: esm+splitting, workerd conditions, `cloudflare:*` and
   `node:*` externals, the `createRequire(import.meta.url ?? "file:///")` banner, and the
   absolute-path `?module` wasm/bin rule. All four were discovered by boot failures, not
   docs — bake them into tests.
4. **Dev v1 (preview-parity) is viable today**: build+bundle+`Runtime.start` is exactly
   this spike. The DO classes, self binding, and assets story all already work.
5. **Sequence the local-KV (or local-R2) plugin before claiming ISR works in dev** —
   it's the only high-severity gap. With it, flip the fixture config to
   `kvIncrementalCache` + DO queue and assert an actual revalidation round-trip.
6. `BuildOutput` mapping is confirmed: `clientDirectory = .open-next/assets` (after the
   cache cp), `serverModules` = dist-worker files entry-first (ESModule/Wasm/Data by
   extension), `externalWorkspaces` = ∅ (OpenNext copies traced files into `.open-next`).

## 6. Exact commands run (for the record)

```sh
# from repo root — install serialized via /tmp/ct-bun-lock spinlock
bun install

cd fixtures/spike-nextjs
node scripts/run-opennext-build.mjs        # rc=0; "OpenNext build complete."
node scripts/bundle.mjs                    # rc=0; 4 output files, 167ms
bun scripts/serve.ts                       # 10/10 checks pass
SPIKE_DEBUG=1 bun scripts/serve.ts         # 11/11 (adds SQLite DO probe)
```

Errors hit along the way (all root-caused, none open):

- `Cannot find module '.../dist/api/package.json.js'` — exports map hides
  `./package.json`; resolve `"."` and walk up.
- `error: Script not found "build"` — `buildNextjsApp` runs the app's `build` script.
- `Error: Dynamic require of "fs" is not supported` (500 on all dynamic routes) —
  fixed by the `createRequire` banner.
- `TypeError: The argument 'path' must be a file URL object... Received 'undefined'`
  (workerd startup) — `import.meta.url` undefined in workerd; `?? "file:///"` fallback.
- Workspace `bun install` interference: no `timeout(1)` on this macOS (wrote a wrapper);
  a sibling spike's too-new deps tripped root `bunfig.toml` `minimumReleaseAge` until
  their pin landed; bun 1.3 isolated-linker layout nests deps under
  `fixtures/spike-nextjs/node_modules` (symlinks into `node_modules/.bun`).
