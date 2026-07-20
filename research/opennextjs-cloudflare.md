# @opennextjs/cloudflare — Integration Research Spec

Research target: **@opennextjs/cloudflare** (`opennextjs/opennextjs-cloudflare` @ `97ef330`, package version `1.20.1`), the adapter that runs a Next.js `standalone` build on Cloudflare Workers via `nodejs_compat`.

Submodule root: `upstream/opennextjs-cloudflare`. All paths below are relative to that root unless noted. The interesting package is `packages/cloudflare`.

Goal: determine how to build an Effect `Context.Service` exposing `{ build, dev }` (shaped like `packages/tools/e2e/src/Vite.ts` in cloudflare-tools) that runs dev against our `cloudflare-runtime` (workerd) and produces a `BuildOutput { clientDirectory, serverModules (entry first), externalWorkspaces }` — with **no wrangler dependency and no wrangler.json**.

---

## 0. Architecture overview

`@opennextjs/cloudflare` is a *build-time adapter* layered on `@opennextjs/aws` (pinned `4.0.2` in `packages/cloudflare/package.json` `dependencies`), which provides the generic OpenNext build core (config compilation, `next build` orchestration, traced-file copying, middleware bundling, esbuild plumbing). The Cloudflare package adds:

- a yargs CLI (`src/cli/index.ts`, bin `opennextjs-cloudflare`) with commands `build`, `preview`, `deploy`, `upload`, `populateCache`, `migrate`;
- a Cloudflare-specific build pipeline (`src/cli/build/build.ts`) that post-processes the `.next` standalone output into a `.open-next/` directory containing a worker entry;
- an esbuild + `@ast-grep/napi` patch corpus (`src/cli/build/patches/**`) that rewrites Next's emitted code to run on workerd;
- a small runtime API surface (`src/api/**`): `getCloudflareContext`, `defineCloudflareConfig`, and cache/queue/tag-cache override implementations backed by Cloudflare bindings (KV, R2, D1, DOs, Workers Assets);
- worker-side templates (`src/cli/templates/worker.ts`, `init.ts`, `images.ts`, `skew-protection.ts`, `shims/*`).

Crucially, there is **no self-contained "run" story**: production serving and local preview are both delegated to **wrangler** (`wrangler deploy` / `wrangler dev`), and the emitted `.open-next/worker.js` is deliberately **left partially unbundled** for wrangler's bundler to finish (see §2.3). Dev (`next dev`) integration is via wrangler's `getPlatformProxy` (miniflare) (see §4).

`wrangler` is a **peerDependency** (`packages/cloudflare/package.json`: `"peerDependencies": { "wrangler": "catalog:" }`), imported directly in five modules (see §5).

---

## A. Programmatic hooks

### A.1 CLI entry → command → build impl

`src/cli/index.ts` (`runCommand`, executed on import via `await runCommand()` at line 44) registers yargs commands:

- `addBuildCommand` → `buildCommand` (`src/cli/commands/build.ts:24`)
- `addPreviewCommand` → `previewCommand` (`src/cli/commands/preview.ts:21`)
- `addDeployCommand` → `deployCommand` (`src/cli/commands/deploy.ts:23`)
- `addUploadCommand` → `uploadCommand` (`src/cli/commands/upload.ts:23`)
- `addPopulateCacheCommand` → `populateCacheCommand` (`src/cli/commands/populate-cache.ts:73`)
- `addMigrateCommand` → `migrateCommand` (`src/cli/commands/migrate.ts:27`)

`buildCommand` (`src/cli/commands/build.ts:24-68`) does:

```ts
const { config, buildDir } = await compileConfig(args.openNextConfigPath); // compiles open-next.config.ts
const options = getNormalizedOptions(config, buildDir);                     // BuildOptions from @opennextjs/aws
// ... interactive wrangler.jsonc existence check (skippable) ...
const wranglerConfig = await readWranglerConfig(args);                      // wrangler.unstable_readConfig
await buildImpl(options, config, projectOpts, wranglerConfig, args.dangerouslyUseUnsupportedNextVersion);
```

The reusable programmatic layer is therefore:

| Function | File | Notes |
| --- | --- | --- |
| `build(options, config, projectOpts, wranglerConfig, allowUnsupported)` | `src/cli/build/build.ts:34` | The whole build pipeline. Exported, plain async function. |
| `compileConfig(configPath?)` | `src/cli/commands/utils/utils.ts:58` | Wraps `compileOpenNextConfig` from `@opennextjs/aws/build/compileConfig.js` (called with `{ compileEdge: true }` at line 86) + `ensureCloudflareConfig` (`src/cli/build/utils/ensure-cf-config.ts:11`). **cwd-coupled**: `nextAppDir = process.cwd()` is module-level (`utils.ts:30`), and it prompts interactively / throws if `open-next.config.ts` is missing. |
| `getNormalizedOptions(config, buildDir)` | `src/cli/commands/utils/utils.ts:118` | `normalizeOptions(config, openNextDistDir, buildDir)` from `@opennextjs/aws/build/helper.js`; resolves `@opennextjs/aws/index.js` via `createRequire`. |
| `readWranglerConfig(args)` | `src/cli/commands/utils/utils.ts:134-139` | `unstable_readConfig({ env, config })` from `wrangler`. Only two fields of the result are consumed by the build (see §5.1) — trivially replaceable with an in-memory object. |
| `previewCommand` etc. | `src/cli/commands/*.ts` | All spawn wrangler; not reusable for us. |

### A.2 Public-API status: the programmatic layer is NOT exported

`packages/cloudflare/package.json` `exports` only exposes the runtime API:

```json
"exports": {
  ".":   { "import": "./dist/api/index.js", ... },
  "./*": { "import": "./dist/api/*.js", ... }
}
```

So `@opennextjs/cloudflare/cli/build/build` is **not** reachable via bare specifier (it would map to the nonexistent `dist/api/cli/build/build.js`). The CLI internals live under `dist/cli/**` and are only reachable by:

1. spawning the bin (`opennextjs-cloudflare build ...`), or
2. absolute-path ESM import (`import(pathToFileURL(require.resolve-ish path into dist/cli/...))`) — bypasses the exports map, works, but is an **internal, unversioned path** (the package's own AGENTS.md calls `src/api` the user surface and `src/cli` internal), or
3. forking/vendoring the pipeline.

**Verdict (A):** CLI-spawn is *not* strictly required — `build()` in `src/cli/build/build.ts` is a clean async function and every stage it calls is a plain exported function — but there is **no stable public programmatic API**. A robust integration should deep-import or vendor `dist/cli/build/build.js` (+ its inputs from `commands/utils/utils.js`) and pin the version, the same way our `Vite.ts` `load()` resolves vite from the project root via `createRequire` + `pathToFileURL` (see `packages/tools/e2e/src/Vite.ts:69-85` in cloudflare-tools).

Caveats for in-process invocation:

- `nextAppDir = process.cwd()` (`src/cli/commands/utils/utils.ts:30`) — must `chdir` to the app root (or reimplement `compileConfig`, which is ~30 lines around `compileOpenNextConfig`).
- `build()` mutates global logger state and calls `process.exit(1)` on Node middleware (`src/cli/build/build.ts:85-88`); `compileConfig` prompts on TTY when config missing (`utils.ts:75`). Prefer running in a child process *of our own entry module* (not the upstream CLI) or pre-validating to avoid `process.exit` killing the Effect runtime. A pragmatic middle ground: in-process import with `openNextConfigPath` guaranteed to exist and Node-middleware pre-checked.
- The pipeline itself shells out anyway: `buildNextjsApp(options)` (from `@opennextjs/aws/build/buildNextApp.js`, called at `src/cli/build/build.ts:81`) runs the app's `next build` via the package manager, and `installDependencies` (`createServerBundle.ts:305`) may run installs. So "programmatic" here means "programmatic orchestration"; heavy subprocesses are inherent.

### A.3 Dev-mode programmatic hooks

There is no dev server in this package at all. The two dev-ish flows:

1. **`next dev` + `initOpenNextCloudflareForDev()`** (`src/api/cloudflare-context.ts:253-269`) — public API, called from the user's `next.config.ts`. It obtains `{ env, cf, ctx }` from **wrangler's `getPlatformProxy`** (dynamic obfuscated import `await import("__wrangler"...)` at `cloudflare-context.ts:345` so Next's compiler can't bundle it), stores it on `globalThis[Symbol.for("__cloudflare-context__")]` (`cloudflare-context.ts:121`, `addCloudflareContextToNodejsGlobal` at 293), and monkey-patches `vm.runInContext` so Next's edge-function sandbox also sees the context (`monkeyPatchVmModuleEdgeContext`, 311-333). Port/URL/shutdown are Next's own (`next dev` owns the server); the proxy is disposed only implicitly.
2. **`opennextjs-cloudflare preview`** (`src/cli/commands/preview.ts:21-59`) — full production build assumed done; populates local caches, then literally spawns **`wrangler dev`** via `runWrangler(buildOpts, ["dev", ...args.wranglerArgs])` (`preview.ts:53`), which uses the user's `wrangler.jsonc` (`main: .open-next/worker.js`, `assets.directory: .open-next/assets` — `packages/cloudflare/templates/wrangler.jsonc`). `runWrangler` (`src/cli/commands/utils/run-wrangler.ts:92-154`) is `spawnSync(packager, ["exec", "wrangler", ...], { shell: true, env: { CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" } })`. No port/URL is surfaced programmatically; it inherits stdio.

**Verdict (dev):** no programmatic dev API exists upstream. Any wrangler-free dev is necessarily ours: either (a) run the built `.open-next` worker in `cloudflare-runtime` (preview-equivalent, no HMR; rebuild-on-change is the only refresh), or (b) keep `next dev` for HMR and replace `getPlatformProxy` with a binding proxy served by `cloudflare-runtime` (see §C.3).

---

## B. Cloudflare integration

### B.1 Build pipeline stages (`src/cli/build/build.ts:34-121`)

Input: the Next app dir. Output: `.open-next/` (name from `normalizeOptions`' default `outputDir`). Stages in order:

1. `options.minify = false` (line 42) — patches are string/AST matched, so the intermediate output is never minified by Next/OpenNext.
2. Pre-flight: `checkRunningInsideNextjsApp`, `printNextjsVersion`, `ensureNextjsVersionSupported` (`src/cli/utils/nextjs-support.ts`), `checkNextVersionSupport` (all `@opennextjs/aws/build/helper.js` except ours). Warning if `wranglerConfig.compatibility_date` older than ~6 months (lines 57-70) — the **only** use of the wrangler config in `build.ts` itself.
3. `buildHelper.initOutputDir(options)` — wipes/creates `.open-next`.
4. `setStandaloneBuildMode(options)`; `buildNextjsApp(options)` (`@opennextjs/aws/build/buildNextApp.js`) — runs **`next build`** with `NEXT_PRIVATE_STANDALONE`, producing `.next/standalone`. Skipped with `--skipNextBuild`.
5. `useNodeMiddleware(options)` guard (`src/cli/build/utils/middleware.ts`) — Node middleware unsupported → `process.exit(1)`.
6. `patchOriginalNextConfig(options)` (`@opennextjs/aws/build/patch/patches/index.js`).
7. `compileCache(options)` (`@opennextjs/aws/build/compileCache.js`) — compiles OpenNext's `cache.cjs` / `composable-cache.cjs` handlers into `.open-next/.build`.
8. `compileEnvFiles(buildOpts)` (`src/cli/build/open-next/compile-env-files.ts:11-20`) — extracts `.env*` values per mode (production/development/test) via `extractProjectEnvVars` (`src/cli/utils/extract-project-env-vars.ts`, uses `@dotenvx/dotenvx`) into **`.open-next/cloudflare/next-env.mjs`** (`export const production = {...}` etc.). Consumed at runtime by `init.ts` (`populateProcessEnv`, `src/cli/templates/init.ts:108-142`).
9. `compileInit(options, wranglerConfig)` (`src/cli/build/open-next/compile-init.ts:12-38`) — esbuilds `templates/init.js` → **`.open-next/cloudflare/init.js`** with `define`s: `__BUILD_TIMESTAMP_MS__`, `__NEXT_BASE_PATH__`, `__DEPLOYMENT_ID__`, `__TRAILING_SLASH__` (from `.next` config via `loadConfig`) and **`__ASSETS_RUN_WORKER_FIRST__` = `wranglerConfig.assets?.run_worker_first ?? false`** (line 33) — the second and last wrangler-config read in the build.
10. `compileImages(options)` (`src/cli/build/open-next/compile-images.ts:11-65`) — esbuilds `templates/images.js` → **`.open-next/cloudflare/images.js`**, `define`-inlining the image config from `.next/images-manifest.json` (remote/local patterns, sizes, qualities, formats, TTL, CSP...). Runtime serves `/_next/image` via the **`IMAGES` binding** and `/cdn-cgi/image/...` in dev.
11. `compileSkewProtection(options, config)` (`src/cli/build/open-next/compile-skew-protection.ts:9-28`) → **`.open-next/cloudflare/skew-protection.js`** (`__SKEW_PROTECTION_ENABLED__` define).
12. `createMiddleware(options, { forceOnlyBuildOnce: true })` (`@opennextjs/aws/build/createMiddleware.js`) — bundles Next middleware as **external middleware** → **`.open-next/middleware/handler.mjs`** (config forces `middleware.external: true`, `wrapper: "cloudflare-edge"` — `defineCloudflareConfig`, `src/api/config.ts:97-108`).
13. `createStaticAssets(options, { useBasePath: true })` (`@opennextjs/aws/build/createAssets.js`) → **`.open-next/assets/`** (public/, `.next/static` under `/_next/static`, etc.). This is the Workers **assets directory** (bound as `ASSETS`); there is **no `_routes.json`** — this is Workers-Assets-based, not Pages, and routing precedence is handled by `run_worker_first` + the asset resolver override (`src/api/overrides/asset-resolver/index.ts`).
14. Unless `dangerous.disableIncrementalCache`: `createCacheAssets(options)` → **`.open-next/cache/`** (prerendered ISR/fetch cache entries; layout: `__fetch/<buildId>/<key>` and `<buildId>/<key>.cache`, parsed by `getCacheAssets`, `src/cli/commands/populate-cache.ts:161-204`); if tag cache in use, `compileCacheAssetsManifestSqlFile` (`src/cli/build/open-next/compile-cache-assets-manifest.ts:10-25`) → **`.open-next/cloudflare/cache-assets-manifest.sql`** (D1 `tags`/`revalidations` DDL + inserts).
15. `createServerBundle(options)` (`src/cli/build/open-next/createServerBundle.ts:43-122`, a copy-edit of the aws one) — per server function: copies cache handlers, copies traced files (`copyTracedFiles`), copies workerd-conditioned packages (`copyWorkerdPackages`, `src/cli/build/utils/workerd.ts:79-104`), applies `applyCodePatches` (aws patches + cloudflare `patchResRevalidate`, `patchUseCacheIO`, `patchTurbopackRuntime`), then `esbuildAsync` of `@opennextjs/aws/adapters/server-adapter.js` → **`.open-next/server-functions/default/<pkgPath>/index.mjs`**.
16. `compileDurableObjects(buildOpts)` (`src/cli/build/open-next/compileDurableObjects.ts:7-37`) — esbuilds the three DO classes (resolved via `_require.resolve("@opennextjs/cloudflare/durable-objects/{queue,sharded-tag-cache,bucket-cache-purge}")`) → **`.open-next/.build/durable-objects/*.js`**, `external: ["cloudflare:workers"]`.
17. `bundleServer(buildOpts, projectOpts)` (`src/cli/build/bundle-server.ts:53-192`) — the big esbuild pass over `server-functions/default/<pkg>/index.mjs` → **`handler.mjs`** (same dir): `platform: "node"`, `format: "esm"`, `conditions: ["workerd"]` (unless `cloudflare.useWorkerdCondition === false`, line 96), ~15 patch plugins (`shimRequireHook`, `inlineDynamicRequires`, `setWranglerExternal`, `fixRequire`, `patchNextServer`, `patchRouteModules`, ...), aliases that shim `node-fetch`/`ws`/`@ampproject/toolbox-optimizer`/`edge-runtime`/`@next/env`/`@vercel/og` to `.open-next/cloudflare-templates/shims/*`, `define`s (`process.env.NEXT_RUNTIME: "nodejs"`, `NODE_ENV: "production"`, `__NEXT_PRIVATE_STANDALONE_CONFIG`, ...), banner importing `node:timers`. Also `copyPackageCliFiles` (`src/cli/build/utils/copy-package-cli-files.ts:13-23`) copies the compiled templates into `.open-next/cloudflare-templates/` and **copies `worker.js` to `.open-next/worker.js`** (`getOutputWorkerPath`, `bundle-server.ts:209-211`). `patchVercelOgLibrary` (`src/cli/build/patches/ast/patch-vercel-og-library.ts:19`) copies `index.edge.js` + `yoga.wasm` out of the nft trace and rewrites imports; `updateWorkerBundledCode` (`bundle-server.ts:197-201`) regexes `__require` → `require`.

The build stage **does not upload anything and talks to no Cloudflare API** (exception: interactive `wrangler.jsonc` creation in `buildCommand` can call `ensureR2Bucket` — CLI-command-level, not `build()`-level).

### B.2 Emitted output layout (`.open-next/`)

```
.open-next/
  worker.js                          # entry (copy of dist/cli/templates/worker.js) — NOT fully bundled
  assets/                            # Workers static assets dir (ASSETS binding); includes _next/static, public/
  server-functions/default/<pkg>/handler.mjs   # bundled Next server (esbuild output, + chunks-less single file)
  middleware/handler.mjs             # external middleware bundle
  cloudflare/init.js                 # runtime init (ALS context, process.env population)
  cloudflare/images.js               # image optimization handlers
  cloudflare/skew-protection.js
  cloudflare/next-env.mjs            # inlined .env values per mode
  cloudflare/cache-assets-manifest.sql
  cloudflare-templates/              # shims (empty.js, env.js, fetch.js, throw.js)
  .build/durable-objects/{queue,sharded-tag-cache,bucket-cache-purge}.js
  .build/open-next.config.edge.mjs   # compiled config (read back by preview/deploy/populateCache via retrieveCompiledConfig, utils.ts:97-109)
  cache/                             # ISR/fetch prerender cache entries (input to populateCache; NOT deployed as-is)
```

The **worker entry** `worker.js` (`src/cli/templates/worker.ts`) default-exports a `fetch` handler and re-exports the three DO classes (`DOQueueHandler`, `DOShardedTagCache`, `BucketCachePurge`, lines 10-14). Flow: `runWithCloudflareRequestContext` (ALS) → skew-protection check → `/cdn-cgi/image/` + `/_next/image` (via `IMAGES`) → middleware handler → dynamic `await import("./server-functions/default/handler.mjs")` (line 49).

**Key gotcha:** every import in `worker.js` is annotated `//@ts-expect-error: Will be resolved by wrangler build` — the final module graph (`worker.js` + `cloudflare/*.js` + `middleware/handler.mjs` + `.build/durable-objects/*.js` + the *dynamically imported* server handler) is stitched together by **wrangler's esbuild bundling at `wrangler dev`/`deploy` time**. Similarly `setWranglerExternal` (`src/cli/build/patches/plugins/wrangler-external.ts:23-46`) leaves `.wasm`/`.bin` imports (e.g. `@vercel/og`'s `resvg.wasm`/`yoga.wasm`) as absolute-path externals *specifically for wrangler to bundle* as WebAssembly modules. A wrangler-free consumer must perform this final bundle itself (§C.2).

### B.3 Dev-mode emulation

- `next dev`: bindings via `getPlatformProxy` (wrangler → miniflare magic proxy) as described in §A.3. All `getCloudflareContext()` calls in user code resolve to that proxy in dev (`src/api/cloudflare-context.ts:340-363`).
- `preview`: real workerd via `wrangler dev` against the built output (§A.3). No vite anywhere; no vite environments.

### B.4 Wrangler / wrangler.json touchpoints (exhaustive)

Direct `wrangler` imports (`grep from "wrangler"` over `src`, excluding specs):

| Site | Symbol | Purpose |
| --- | --- | --- |
| `src/cli/commands/utils/utils.ts:10,138` | `unstable_readConfig` | Parse `wrangler.jsonc` (+ `--env`) into `Unstable_Config` for build/preview/deploy/upload/populateCache. |
| `src/cli/commands/utils/helpers.ts:2,42` | `getPlatformProxy` | `getEnvFromPlatformProxy` — merge wrangler `vars`/`.dev.vars` into env for populateCache/deploy/upload/skew-protection. |
| `src/cli/commands/populate-cache.ts:20-21,307` | `Unstable_Config` type, `unstable_startWorker` | Starts an ephemeral worker (`src/cli/workers/r2-cache.ts`) with an R2 binding to bulk-populate the incremental cache (local: miniflare R2 storage; `--remote`: proxied to real R2). |
| `src/cli/build/build.ts:9,57` / `src/cli/build/open-next/compile-init.ts:7,33` | `Unstable_Config` type | Reads only `compatibility_date` (warning) and `assets.run_worker_first` (define). |
| `src/api/cloudflare-context.ts:3,345` | `GetPlatformProxyOptions` type; dynamic `import("wrangler")` | `initOpenNextCloudflareForDev`. |

Spawned `wrangler` subcommands (all via `runWrangler`, `src/cli/commands/utils/run-wrangler.ts:92`):

- `wrangler dev` — `preview.ts:53`.
- `wrangler deploy` — `deploy.ts:58-77` (sets `OPEN_NEXT_DEPLOY=true`, optional `--var __DEPLOYMENT_MAPPING__` for skew protection).
- `wrangler versions upload` — `upload.ts:58-68`.
- `wrangler kv bulk put --binding NEXT_INC_CACHE_KV --local|--remote` — `populate-cache.ts:714-728`.
- `wrangler d1 execute NEXT_TAG_CACHE_D1 --command "CREATE TABLE ..." --local|--remote` — `populate-cache.ts:754-797`.
- `wrangler auth token --json` / `wrangler login` — `src/cli/utils/ensure-r2-bucket.ts:34,104` (credentials for the `cloudflare` SDK to create the R2 cache bucket).

`wrangler.jsonc` file-level coupling:

- `buildCommand` refuses to run without a wrangler config file unless `--skipWranglerConfigCheck`/`SKIP_WRANGLER_CONFIG_CHECK=yes` (`src/cli/commands/build.ts:43-63`); offers to create one from `templates/wrangler.jsonc` (`src/cli/utils/create-wrangler-config.ts:43-73`).
- The template config (`packages/cloudflare/templates/wrangler.jsonc`) is the de-facto **deployment contract**: `main: ".open-next/worker.js"`, `compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"]`, `assets: { directory: ".open-next/assets", binding: "ASSETS" }`, self-service-binding `WORKER_SELF_REFERENCE`, `r2_buckets: [{ binding: "NEXT_INC_CACHE_R2_BUCKET", ... }]`, `images: { binding: "IMAGES" }`. Users add `durable_objects` + `migrations` for DO queue/sharded tag cache per the docs.
- `populateCache` reads `config.r2_buckets` / `config.kv_namespaces` / `config.d1_databases` to find bucket/namespace/database attached to the well-known binding names (`populate-cache.ts:256-268,674-679,747-750`).

### B.5 Runtime bindings / env contract

Declared on the global `CloudflareEnv` (`src/api/cloudflare-context.ts:11-94`); binding-name constants exported from the overrides:

| Binding / var | Type | Used by |
| --- | --- | --- |
| `ASSETS` | Fetcher (Workers assets) | asset resolver override (`src/api/overrides/asset-resolver/index.ts`), static-assets incremental cache (`CACHE_DIR = "cdn-cgi/_next_cache"`, `static-assets-incremental-cache.ts:14`) |
| `IMAGES` | Images binding | `cloudflare/images.js` (`/_next/image`) |
| `WORKER_SELF_REFERENCE` | Service binding to self | ISR revalidation queue (DO queue calls back into the worker), cache interception |
| `NEXT_INC_CACHE_KV` (+ `NEXT_INC_CACHE_KV_PREFIX`) | KV | `kv-incremental-cache.ts` (`NAME = "cf-kv-incremental-cache"`) |
| `NEXT_INC_CACHE_R2_BUCKET` (+ `NEXT_INC_CACHE_R2_PREFIX`) | R2 | `r2-incremental-cache.ts` (`NAME = "cf-r2-incremental-cache"`) |
| `NEXT_TAG_CACHE_D1` | D1 | `d1-next-tag-cache.ts` |
| `NEXT_TAG_CACHE_KV` | KV | `kv-next-tag-cache.ts` |
| `NEXT_TAG_CACHE_DO_SHARDED` (+ `_DLQ` Queue) | DO namespace | `do-sharded-tag-cache.ts` (class `DOShardedTagCache`) |
| `NEXT_CACHE_DO_QUEUE` (+ `NEXT_CACHE_DO_QUEUE_*` tuning vars) | DO namespace | `do-queue.ts` (class `DOQueueHandler`) |
| `NEXT_CACHE_DO_PURGE` (+ buffer var), `CACHE_PURGE_ZONE_ID`, `CACHE_PURGE_API_TOKEN` | DO namespace / vars | `cache-purge/index.ts` (class `BucketCachePurge`) |
| `NEXTJS_ENV` | var | selects which `next-env.mjs` mode to load |
| `CF_WORKER_NAME`, `CF_PREVIEW_DOMAIN`, `CF_WORKERS_SCRIPTS_API_TOKEN`, `CF_ACCOUNT_ID` | vars | skew protection |

Runtime access pattern: the worker entry populates `process.env` from `env` strings (`init.ts:108-131`) and exposes `{ env, cf, ctx }` via ALS + `Symbol.for("__cloudflare-context__")`; user code calls `getCloudflareContext()` (`cloudflare-context.ts:147`). Overrides read bindings from `getCloudflareContext().env` by the constant names above.

### B.6 Is the build stage itself wrangler-free?

**Almost.** `build()`'s only wrangler needs are:

1. the `Unstable_Config` **type** with two consumed fields — `compatibility_date` (log warning, `build.ts:57-70`) and `assets.run_worker_first` (`compile-init.ts:33`);
2. the parser `unstable_readConfig` used by the *command* wrapper, not by `build()` itself;
3. the wrangler-config-existence prompt in the *command* wrapper.

Passing `{ compatibility_date: "...", assets: { run_worker_first: true } }` as a plain object makes the whole `build()` pipeline run with **zero wrangler code**. Everything else in the pipeline is esbuild + `@opennextjs/aws` + `@ast-grep/napi` + fs. The catch is §B.2: the output is not a finished worker bundle.

---

## C. Adaptation plan for cloudflare-tools + alchemy

Target shape (mirroring `packages/tools/e2e/src/Vite.ts`):

```ts
export class OpenNext extends Context.Service<OpenNext, {
  build: (options?: OpenNextBuildOptions) => Effect.Effect<BuildOutput, OpenNextError>;
  dev:   (options?: OpenNextDevOptions)   => Effect.Effect<{ url: string; ... }, OpenNextError, Scope.Scope>;
  readBuildOutput: () => Effect.Effect<BuildOutput, PlatformError>;
}>()("@alchemy/OpenNext") {}
```

### C.1 `build`: reuse upstream pipeline, supply config in-memory, add a final bundle pass

1. **Invoke the upstream pipeline programmatically** (per §A.2): resolve `@opennextjs/cloudflare` from the app root (`createRequire(appRoot/package.json)`), `pathToFileURL`-import `dist/cli/build/build.js` and `dist/cli/commands/utils/utils.js` (for `compileConfig`/`getNormalizedOptions`) — or reimplement those two thin helpers over `@opennextjs/aws/build/compileConfig.js` + `helper.js` to avoid the cwd/TTY coupling. Run inside `Effect.tryPromise` with cwd set to the app root.
2. **Synthesize the `Unstable_Config` in memory** — a plain object `{ compatibility_date, assets: { run_worker_first: true } }`. No `wrangler.jsonc` on disk; skip the config check entirely (we never go through `buildCommand`).
3. **Finish the bundle ourselves** (replacing wrangler's implicit final build): run our bundler (`cloudflare-rolldown-plugin`, or the same esbuild) with entry `.open-next/worker.js`, resolving the relative imports (`./cloudflare/*.js`, `./middleware/handler.mjs`, `./.build/durable-objects/*.js`) and the **dynamic** `import("./server-functions/default/handler.mjs")` (keep it a separate lazily-loaded chunk — it's large and upstream relies on lazy evaluation for middleware-only responses), plus `.wasm`/`?module` imports as `WebAssembly.Module` modules (we already handle wasm in `cloudflare-vite-plugin`; cf. commit `41778cabb fix(cloudflare): handle wasm in vite dev`). `nodejs_compat` + `global_fetch_strictly_public` compat flags and a current `compatibility_date` are part of the worker metadata we generate.
4. **Map to `BuildOutput`**:
   - `clientDirectory` → `.open-next/assets` (upload as Workers assets; bind as `ASSETS`).
   - `serverModules` → the final bundle's emitted chunks, entry (`worker.js` bundle) first, plus any `.wasm` companions; hash contents as in `Vite.ts` (`toOutputFile`, `Vite.ts:115-120`).
   - `externalWorkspaces` → derivable the same way `Vite.ts` does (module ids outside root during our final bundle pass); mostly empty because OpenNext copies traced files into `.open-next`.
5. **Cache population without wrangler** — reimplement `populateCache` against alchemy/cloudflare-runtime primitives:
   - Asset collection: reuse `getCacheAssets` + `computeCacheKey` (`src/cli/commands/populate-cache.ts:161-204`; `src/api/overrides/internal.ts` — these *are* under `dist/api`, hence public-ish for `internal.js`... `computeCacheKey` is exported from `dist/api/overrides/internal.js`, reachable via the `./*` export).
   - Remote R2/KV/D1: use distilled Cloudflare SDK / alchemy resources directly (no `unstable_startWorker`, no `wrangler kv bulk put`; the D1 DDL strings at `populate-cache.ts:758-765,786-789` and `cache-assets-manifest.sql` are plain SQL we can execute via the D1 HTTP API).
   - Local dev: write into `cloudflare-runtime`'s local R2/KV/D1 storage via its own binding services.
   - `static-assets` incremental cache needs no population infra at all: `cpSync(cache → assets/cdn-cgi/_next_cache)` (`populate-cache.ts:802-812`).
6. **Env vars**: replace `getEnvFromPlatformProxy` (`helpers.ts:37-73`) with our own merge of process env + alchemy-provided vars + `.env*` (upstream's `extractProjectEnvVars` is reusable via deep import, or trivially reimplemented with dotenvx).

### C.2 `dev` (preview-style) against cloudflare-runtime

Run the §C.1 output in `cloudflare-runtime`: declare the worker with modules = `serverModules`, assets = `clientDirectory` (with `run_worker_first: true` and binding `ASSETS`), plus bindings per §B.5: `IMAGES` (needs an images-binding emulation in cloudflare-runtime — check coverage; miniflare has one to crib from `upstream/workers-sdk/packages/miniflare/src/plugins`), `WORKER_SELF_REFERENCE` (self service binding), the chosen cache bindings, and the three DO classes declared on the same worker (`DOQueueHandler`, `DOShardedTagCache`, `BucketCachePurge` are exported from the entry, so a `durable_objects` declaration pointing at the same script suffices; SQLite-backed classes for the DO queue by default). Expose `{ url }` from the runtime's listen address; shutdown via `Effect.acquireRelease` like `Vite.ts:257-270`. File-watch + rebuild gives coarse reload; there is no HMR in this mode (parity with upstream `preview`).

### C.3 `dev` (next-dev-style, optional phase 2)

Keep `next dev` for real HMR and replace the wrangler proxy: implement our own `initOpenNextCloudflareForDev` equivalent that builds `{ env, cf, ctx }` from **cloudflare-runtime**-backed Node-side proxies (loopback HTTP/RPC to a workerd instance hosting the bindings — the moral equivalent of miniflare's `getBindings()`/magic proxy). The upstream global contract is tiny and stable: set `globalThis[Symbol.for("__cloudflare-context__")]` (`cloudflare-context.ts:121`) and patch `vm.runInContext` (`cloudflare-context.ts:311-333`, copyable verbatim). User's `next.config.ts` would import our init instead of upstream's. This is net-new proxy machinery in cloudflare-runtime (KV/R2/D1/DO/Images/Service callable from Node) and is the largest single piece of §C.

### C.4 Reuse vs fork vs reimplement

**Reuse as-is (npm dep, deep import where unexported):**
- The entire build pipeline: `build()` + all `src/cli/build/**` stages and patches; `@opennextjs/aws` helpers.
- Runtime `src/api/**` (published under `dist/api`, real exports): overrides, DOs, `getCloudflareContext`, `computeCacheKey`.
- Templates (compiled into `dist/cli/templates`, copied by the build itself).
- `getCacheAssets` (deep import) or 40-line reimplementation.

**Reimplement (small):**
- `compileConfig` + `getNormalizedOptions` wrappers (to drop cwd/TTY/`process.exit` coupling) — ~50 lines over `@opennextjs/aws` exports.
- In-memory `Unstable_Config` stand-in (2 fields).
- `populateCache` targets (R2/KV/D1 writers over distilled SDK + cloudflare-runtime local storage).
- Env merging (replace `getEnvFromPlatformProxy`).

**Build new:**
- Final worker bundling pass (`.open-next/worker.js` → finished modules) with wasm/`?module` support and a lazily-loaded server chunk.
- cloudflare-runtime coverage: Images binding emulation; self-service binding; DO-on-same-worker declaration; (phase 2) Node-side binding proxy for next-dev mode.
- The Effect service itself + alchemy resource wiring (Worker resource consumes `BuildOutput`; cache resources: R2 bucket / KV namespace / D1 database + population as part of deploy, replacing `deploy`/`upload` commands entirely — alchemy already owns worker upload).

**Explicitly dropped:** `runWrangler`, `preview`/`deploy`/`upload` commands, `ensure-r2-bucket.ts` (wrangler auth) — alchemy resources replace all of it. Skew protection can be deferred (needs versions API + `--var` injection; alchemy's worker resource can model it later).

### C.5 Risks & unknowns

1. **No stable programmatic API**: `dist/cli/**` deep imports are unversioned internals; upstream moves fast (patch corpus churns with each Next release). Mitigation: pin the version (like `@opennextjs/aws` is pinned to `4.0.2` upstream) and add an e2e fixture that builds a real Next app.
2. **Final-bundle fidelity**: we take over wrangler's undocumented finishing step. Risks: wasm module rules, `.bin` imports, keeping `handler.mjs` lazy, `nodejs_compat` internal-module externals (`cloudflare:workers` is already external in DO compile). Needs an e2e matrix (basic app, ISR, PPR off, middleware, @vercel/og, pages router).
3. **`next build` subprocess** is unavoidable (spawned by `buildNextjsApp`); our service is "programmatic orchestration", not single-process purity. Also `process.chdir` requirements conflict with concurrent builds in one process — run builds in a worker/child process of our own.
4. **Images binding emulation** in cloudflare-runtime may not exist yet; dev image optimization would 500 without it (upstream dev has the same gap unless miniflare emulates it — miniflare has a basic transformer to port).
5. **DO queue/tag-cache semantics under our runtime**: `DOQueueHandler` uses SQLite-in-DO and `WORKER_SELF_REFERENCE` fetches back into the worker; loopback service bindings and SQLite-backed DOs must both work in cloudflare-runtime.
6. **next-dev-mode proxy (phase 2)** is a significant new subsystem (Node↔workerd binding proxy) with subtle semantics (streaming bodies, DO stubs over the wire, `cf` object fidelity).
7. **`process.exit` / interactive prompts** inside upstream code paths we still call (`build()` exits on Node middleware, `build.ts:85-88`) — must pre-validate or isolate in a child process to avoid killing the Effect runtime.
8. **Windows paths** — upstream normalizes aggressively (`normalize-path.ts`); our final bundle pass must match (`worker.js` relative imports are POSIX).
9. **Cache population at deploy time** interacts with alchemy's resource model (population is a post-upload imperative step touching R2/KV/D1 contents, not resource config) — needs a home (e.g. a `Command`-like resource or part of the Worker deploy effect) with idempotency (keys are content-addressed per buildId, so re-runs are safe).

### C.6 Effort estimate

**Large.** The build reuse is genuinely cheap (days), but the final-bundle pass + cloudflare-runtime binding coverage (Images, self-service, DOs) + populate-cache reimplementation + e2e hardening is multi-week; next-dev HMR mode (phase 2) is another sizeable chunk on top.
