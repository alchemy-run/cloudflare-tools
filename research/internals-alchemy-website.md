# Alchemy internals: Cloudflare.Website.* — onboarding spec for framework resources (Nextjs, Astro, SvelteKit, Waku)

Repo root: `/Users/john/Developer/Alchemy/alchemy-effect` (all paths below are relative to it unless absolute).
`cloudflare-tools/` and `distilled/` are git submodules that are ALSO bun workspaces of this monorepo (see root `package.json` `workspaces.packages`: `cloudflare-tools/packages/*`, `cloudflare-tools/packages/vendor/*`, `cloudflare-tools/packages/tools/*`, `distilled/packages/*`).

---

## 1. `packages/alchemy/src/Cloudflare/Website/` — the two existing Website resources

Directory contents (all of it):

```
packages/alchemy/src/Cloudflare/Website/
├── index.ts        # export * from "./StaticSite.ts"; export * from "./Vite.ts";
├── Vite.ts         # Cloudflare.Website.Vite
└── StaticSite.ts   # Cloudflare.Website.StaticSite
```

Neither file is a Provider. **Both are thin composites over the `Worker` resource** (`packages/alchemy/src/Cloudflare/Workers/Worker.ts`). There is no `Website`-specific provider, no lifecycle code, and no entry in `packages/alchemy/src/Cloudflare/Providers.ts` — the underlying `Workers.WorkerProvider()` and `Command.providers()` (both already registered in `Providers.ts`) do all the work.

### 1a. `Website.Vite` (`Website/Vite.ts`, exported symbols: `Vite`, `ViteProps`)

`ViteProps<Bindings>` = `Omit<WorkerProps<Bindings>, "vite" | "main" | "assets"> & ViteOptions & { assets?: AssetsConfig }`.

The implementation is ~15 lines: it maps its props into `WorkerProps` and delegates directly to `Worker(id, propsEffect)`:

```ts
Worker(id, Effect.map(propsEff, (props) => ({
  ...props,
  main: undefined!,
  vite: {
    main: props?.main,                       // custom deployed entry (optional)
    rootDir: props?.rootDir,                 // Vite root, default process.cwd()
    memo: props?.memo,                       // input-hash scope (+ workspaces: "auto")
    viteEnvironments: props?.viteEnvironments, // { entry: "ssr"|"rsc"..., children: [...] }
  },
})))
```

So `Website.Vite` is literally `Worker` with the internal `WorkerProps.vite?: ViteOptions` prop set (marked `@internal used by Cloudflare.Website.Vite resource` in `Worker.ts` line ~369). `ViteOptions` itself is declared in `Workers/Worker.ts` (fields: `main?`, `rootDir?`, `memo?` incl. `workspaces?: "auto" | [...]`, `viteEnvironments?: { entry?, children? }`).

Both `Vite` and `StaticSite` support two call forms via `effectClass` (`packages/alchemy/src/Util/effect.ts`):
- value form: `yield* Cloudflare.Website.Vite("Website", props?)` → `Effect<Worker<...>, never, Providers>`
- class form: `class Website extends Cloudflare.Website.Vite<Website>()("Website", props) {}` — the class is both an Effect and a bindable type (other Workers can `env: { SITE: Website }`).

The resulting Worker's binding type is `NormalizedBindings<Bindings, WorkerAssetsConfig>`, i.e. the user's `env` bindings **plus a synthesized `ASSETS: Assets` binding**.

### 1b. Where the vite build actually runs

Trace: `Worker` resource → `WorkerProvider` (`packages/alchemy/src/Cloudflare/Workers/WorkerProvider.ts`, 3181 lines).

- `WorkerProvider()` (line ~428) is `ProviderLayer.select({ live: LiveWorkerProvider, local: LocalWorkerProvider })` — deploy vs `alchemy dev`.
- In `LiveWorkerProvider`, `prepareAssetsAndBundle(id, props)` (line ~1293) branches:
  1. `props.script !== undefined` → inline script, hash with sha256, no assets read when skipped.
  2. **`props.vite` → `viteBuild(props)` (line ~1173)** ← this is where the Vite build runs during deploy.
  3. otherwise → `prepareAssets(props.assets)` + `prepareBundle(id, props)` (rolldown via `WorkerBundle`, or `readPrebuiltWorkerBundle` when `bundle: false`, or Python).
- `viteBuild` (provider, line 1173):
  - Lazily `import("./Vite.ts")` — i.e. `packages/alchemy/src/Cloudflare/Workers/Vite.ts` (NOT the Website file; note there are **two** `Vite.ts` files) — because it pulls in `@distilled.cloud/cloudflare-vite-plugin` (~0.5s load).
  - Resolves `props.env` into a plain string map (unwraps `Redacted`, runs `Config` Effects, skips `WorkerLoader` bindings) and passes it as the `env` for `VITE_`-prefixed define injection.
  - Calls `Vite.viteBuild(props.vite?.rootDir, env, { main, compatibilityDate, compatibilityFlags, viteEnvironments })`.
  - From the result `{ clientDirectory, serverBundle, externalWorkspaces }` it, in parallel:
    - `readAssets({ ...props.assets, directory: resolve(rootDir, clientDirectory) })` — client output becomes Worker static assets,
    - awaits `serverBundle` (the SSR/RSC chunks),
    - `hashViteInput(rootDir, props.vite?.memo, externalWorkspaces)` — the **input** content hash.
  - Returns `{ assets, bundle, input, additionalWorkspaces }`. Dies if neither assets nor bundle were produced.
- `Workers/Vite.ts` `viteBuild` (line 108):
  - Sets `process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED = "1"` (contract: app `vite.config.ts` should stand down its own `cloudflare()` plugin instance when this is set — documented in the long comment at line ~46).
  - `loadVite(rootDir)` — resolves the **project's own** `vite` via `createRequire(rootDir/package.json)`, falling back to alchemy's bundled vite.
  - `vite.createBuilder({ root, define: getDefine(env), plugins: [cloudflare(pluginOptions), outputPlugin.plugin], customLogger, logLevel: "warn" }, null)` then `builder.buildApp()`. `cloudflare` = default export of `@distilled.cloud/cloudflare-vite-plugin`. `define` only inlines `VITE_`-prefixed env keys as `import.meta.env.*`.
  - `outputPlugin` = `viteBuildOutputPlugin` from `packages/alchemy/src/Bundle/Vite.ts`.
- `Bundle/Vite.ts` `viteBuildOutputPlugin({ entryEnvironment })` (255 lines) — a Vite plugin `alchemy:build-output` that collects per-environment `writeBundle` output:
  - `client` environment → records `clientDirectory` (the built asset dir).
  - `entryEnvironment` (default `"ssr"`; `"rsc"` for RSC frameworks) → finds the entry chunk; its name becomes the Worker main module.
  - All server-environment chunks are collected into `serverChunks`, **prefixed with the environment's relative `outDir`** (e.g. `dist/ssr/worker.js`, `dist/rsc/index.js`) so cross-environment relative imports resolve; RSC manifests (`__vite_rsc_assets_manifest.js`, `__vite_rsc_env_imports_manifest.js`) are read from disk post-build and keyed per environment.
  - Module ids resolved from outside the project root (not node_modules) are recorded → `externalWorkspaces` (monorepo workspace dirs, found via `findUp(package.json)`) — these get hashed into the input hash so a linked workspace edit busts the memo.
  - Result: `ViteBuildOutput = { clientDirectory, serverBundle: Effect<BundleOutput|undefined>, externalWorkspaces: Effect<Set<string>> }`.

### 1c. Content-hash skipping (memoization)

Worker attributes carry `hash: { assets, bundle, input, additionalWorkspaces, metadata }` (`Workers/Worker.ts` Worker type, line ~654).

- **Diff-time** (`hasChanged`, provider line ~2049): for `props.vite`, only `hashViteInput(rootDir, memo, storedAdditionalWorkspaces)` is recomputed and compared to `output.hash.input`. Equal → no update → **no vite build, no upload**. The input hash hashes every non-gitignored file in `rootDir` (via `hashDirectory` from `packages/alchemy/src/Command/Memo.ts`, `MemoOptions` `include`/`exclude` narrow it) plus each external workspace directory. A metadata-surface hash (`resolveWorkerMetadataHash`) is compared first so metadata-only edits (env, flags, observability, routes...) still deploy.
- **Apply-time**: even when an update runs, `readAssets` (`Workers/Assets.ts`) computes a manifest hash (per-file sha256/32-hex + config + `_headers` + `_redirects`; directory path deliberately excluded for machine portability). `putWorker` compares it (`normalizePrebuiltAssets`, `keepAssets`) — matching hash skips the asset upload session entirely and reuses Cloudflare's stored manifest. Cloudflare's upload session is itself content-addressed: `createScriptAssetUpload` returns only the missing-hash `buckets` to upload (`uploadAssets`, `Workers/Assets.ts` line 196: base64 File bodies per bucket via `createAssetUpload`, returns a completion `jwt`).

### 1d. `Website.StaticSite` (`Website/StaticSite.ts`, exported symbols: `StaticSite`, `StaticSiteProps`)

`StaticSiteProps<Bindings>` = `Omit<WorkerProps<Bindings, WorkerAssetsConfig>, "assets" | "dev"> & Omit<Command.BuildProps, "env"> & { assets?: AssetsConfig; dev?: { command, cwd?, env?, url? } }`.

`makeStaticSite` composes **three resources under a namespace** (`Namespace.push(id)` so children are scoped under the logical id):

1. Dev mode only (`ctx.dev && props.dev`, via `AlchemyContext.dev`): `Command.Dev("Dev", { command, cwd, env })` — a sidecar-owned long-lived dev process (`packages/alchemy/src/Command/Dev.ts`); its detected `url` output (or `props.dev.url` fallback) becomes the site URL. Build is skipped.
2. Otherwise: `Command.Build("Build", { command, cwd, memo, outdir, env })` (`packages/alchemy/src/Command/Build.ts`) — runs the shell build, content-hashes inputs (memoized skip), outputs `{ outdir, hash }`.
3. `Worker("Worker", { ...props, assets: { directory: build.outdir, hash: build.hash, ...props.assets }, dev: dev ? { mode: "external", url: dev.url } : undefined, script: fallbackScript ?? props.script })`.

`fallbackScript` (injected when neither `main` nor `script` given):
```ts
export default { fetch: (request, env) => env.ASSETS.fetch(request) };
```
The `assets` passed to Worker is the `AssetsWithHash` shape (`Workers/Worker.ts` line ~214) — the precomputed `Command.Build` hash drives diff short-circuiting as described in 1c. In dev, `dev: { mode: "external", url }` tells the local Worker provider not to start workerd at all (stub attributes only).

---

## 2. Worker binding contract and how a Website maps onto `putWorker`

`Worker` resource type (`Workers/Worker.ts` line ~635):

```ts
Resource<"Cloudflare.Worker", WorkerProps<Bindings>, Attributes, BindingContract, Providers>
// BindingContract:
{
  bindings?: WorkerBinding[];      // native CF bindings pushed by Binding.Services via host.bind`${res}`(...)
  cache?: WorkerCache;
  containers?: { className; dev }[];
  crons?: string[];
  hyperdrives?: Record<string, Required<DevOrigin>>;
}
```

`WorkerBinding` union is in `Workers/WorkerBinding.ts` (wire shapes: `kv_namespace`, `r2_bucket`, `d1`, `durable_object_namespace`, `service`, `assets`, `plain_text`, `secret_text`, `json`, ...).

`putWorker` (`WorkerProvider.ts` line ~1367) — the single upload path used by create/update/adopt:

1. Physical name: `output?.workerName ?? createWorkerName(id, news.name)` (`Workers/WorkerName.ts`).
2. `prepareAssetsAndBundle` (section 1b) → `{ assets, bundle: { main, files: File[] }, hash }`. For a Website.Vite worker, `bundle.main` is the environment-prefixed server entry (e.g. `dist/ssr/worker.js`) and `bundle.files` are all server chunks; `assets` is the built client directory. For StaticSite, `bundle` is the tiny fallback script (`main.js`) and `assets` the `outdir`.
3. Asset flow: hash-match → `keepAssets` + `metadata.assets = { config }`; else `uploadAssets` → `metadata.assets = { jwt, config }`. Either way a `{ type: "assets", name: "ASSETS" }` binding is appended — this is what backs the `ASSETS` env binding and the `NormalizedBindings ... & { ASSETS: Assets }` type.
4. Resource bindings from the binding contract (`b.data.bindings`) are flattened into `metadataBindings` (with `transferredFrom` stripped from DO bindings); alchemy control bindings appended (`ALCHEMY_PHASE=runtime`, `ALCHEMY_STACK_NAME`, `ALCHEMY_STAGE`, `ALCHEMY_CLOUDFLARE_ACCOUNT_ID`); `news.env` literals appended by shape (Redacted→`secret_text`, string→`plain_text`, other→`json`).
5. Durable Object migration bookkeeping (script tags `alchemy:dos:`/`alchemy:migration-tag:`, `new_sqlite_classes`/`renamed_classes`/`transferred_classes`/`deleted_classes`) — relevant to Website.Vite when `vite.main` exports DO classes (see the `vite-do-fixture` test).
6. Upload via distilled `workers.putScript` (`@distilled.cloud/cloudflare/workers` `PutScriptRequest`): multipart `metadata` (main_module, bindings, compatibility, observability [default `{ enabled: true, logs: { enabled: true, invocationLogs: true } }`], cache, limits, placement, tags, migrations, assets) + module `File`s. Then reconciles workers.dev subdomain, custom domains, zone routes, crons. Retries eventual-consistency tags (`MissingDurableObjects`, `WorkerHasNoVersions`, `WorkerNotFound`, ...).
7. Returns Attributes incl. `hash` (see 1c) — `stables: ["workerId", "workerName"]`.

**Prebuilt path relevant to Nextjs/OpenNext:** `WorkerProps.bundle: false` + `main` pointing at a complete ESM worker (e.g. `./.open-next/worker.js`) skips rolldown entirely — `readPrebuiltWorkerBundle` (`Workers/WorkerBundle.ts`) walks `main`'s directory, uploading every file matching `rules` (default `defaultModuleRules`: ESModule `**/*.js|mjs`, CompiledWasm `**/*.wasm`, Text `**/*.txt|html|sql`, Data `**/*.bin`) byte-for-byte, module names = POSIX paths relative to the entry dir (Wrangler `no_bundle` contract). The Worker JSDoc explicitly shows the OpenNext example (`Worker.ts` @example "Deploying a prebuilt Worker without bundling").

---

## 3. How cloudflare-tools packages are consumed from alchemy

Dependency direction: **alchemy → cloudflare-tools** (never the reverse). cloudflare-tools is a standalone published monorepo (`https://github.com/alchemy-run/cloudflare-tools`, npm scope `@distilled.cloud`), vendored here as submodule + workspaces.

Packages (`cloudflare-tools/packages/`):

| Package | Purpose | Consumed from |
|---|---|---|
| `@distilled.cloud/cloudflare-vite-plugin` (v0.13.7) | Vite plugin: composes rolldown plugin (build transforms) + cloudflare-runtime (dev server in workerd). Default export `cloudflare(options)`; `CloudflareVitePluginOptions extends BasePluginOptions` + `{ worker?, context? }` | `packages/alchemy/src/Cloudflare/Workers/Vite.ts` |
| `@distilled.cloud/cloudflare-rolldown-plugin` | Rolldown/Vite plugin set: `optionsPlugin`, `cloudflareExternalsPlugin`, `nodejsUnenvPlugin`, `nodejsAlsPlugin`, `virtualModulesPlugin`, `wasmInitPlugin`, `additionalModulesPlugin`; `BasePluginOptions` (= `main`, `compatibilityDate`, `compatibilityFlags`, `exports`, `viteEnvironments`) in `src/options.ts` | `packages/alchemy/src/Cloudflare/Workers/WorkerBundle.ts`, `packages/alchemy/src/Bundle/Bundle.ts` |
| `@distilled.cloud/cloudflare-runtime` | Effect-native local workerd runtime (`Runtime.start`), binding hooks (`.../bindings`: `KvNamespace.remote`, `R2Bucket.remote`, `Assets.local`, ...), `proxy/WorkerProxy` | `packages/alchemy/src/Cloudflare/LocalRuntime.ts`, `Workers/LocalWorkerProvider.ts`, `Containers/*` |

Version pinning: root `package.json` catalog maps all three to `"workspace:*"`; `packages/alchemy/package.json` depends on them via `"catalog:"` (lines ~318–320). So inside the monorepo they resolve to the submodule sources/dist; on publish the catalog entry is materialized. Build order: root `prepare` script runs `bun build:cloudflare-tools` = `bun tsc -b distilled/packages/cloudflare/tsconfig.json && bun run --filter './cloudflare-tools/packages/*' build` (the vite-plugin/runtime build with `tsdown`; runtime `.worker.ts` internal workers must be rebuilt after edits — see `cloudflare-tools/AGENTS.md`). Sync submodules with `bun sync:submodules`.

**Framework upstream sources are vendored in cloudflare-tools** for reference: `cloudflare-tools/upstream/{next.js, opennextjs-cloudflare, astro, sveltekit, waku, workers-sdk}` (shallow submodules, see `cloudflare-tools/.gitmodules`). Framework agents should read these rather than guessing adapter behavior. `cloudflare-tools/fixtures/` has vite-plugin fixtures (react-router-rsc, solidstart, tanstack-start, solid-ssr, static-website).

Distilled (`distilled/packages/cloudflare`, `@distilled.cloud/cloudflare` = `workspace:*`) is the typed Cloudflare API client used by the provider (`workers.putScript`, asset upload, etc.) — separate repo/submodule from cloudflare-tools.

---

## 4. Examples exercising Website.Vite / StaticSite

Grep hits (`examples/*/alchemy.run.ts`): `cloudflare-tanstack`, `cloudflare-tanstack-rpc-drizzle`, `cloudflare-tanstack-start-solid`, `cloudflare-solidstart`, `cloudflare-solidjs-ssr`, `cloudflare-vue`, `cloudflare-static-site`, `monorepo-single-stack`, `monorepo-multi-stack/frontend`, plus AWS twins `aws-vite`, `aws-static-site`. NOTE: `examples/cloudflare-nextjs/` exists but is **empty** (only a `.env`) — an unstarted placeholder a Nextjs agent will likely fill.

Canonical example structure (`examples/cloudflare-tanstack/`):

```
alchemy.run.ts     # the stack: default-exports Alchemy.Stack(...)
vite.config.ts     # framework plugins only (tanstackStart(), viteReact()) — NO cloudflare plugin needed
package.json       # scripts: dev="alchemy dev", deploy="alchemy deploy", destroy="alchemy destroy"
src/               # app code (+ src/backend.ts defining a Worker class + R2 Bucket)
test/              # optional integ test
tsconfig.json
```

`alchemy.run.ts` pattern:

```ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export class Website extends Cloudflare.Website.Vite<Website>()("Website", {
  compatibility: { flags: ["nodejs_compat"] },
  env: { BUCKET: Bucket, BACKEND: Backend },
  assets: { runWorkerFirst: true },
}) {}
export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>;

export default Alchemy.Stack("CloudflareTanstackExample",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const website = yield* Website;
    return { websiteUrl: website.url.as<string>() };
  }),
);
```

`examples/cloudflare-static-site/alchemy.run.ts` (Zola SSG) shows the StaticSite shape: `{ command: "zola build", outdir: "public", dev: { command: "zola serve" }, assets: { notFoundHandling: "404-page" } }`.

Example deps: `"alchemy": "workspace:*"`, `"effect": "catalog:"`, `"vite": "catalog:"` (catalog vite is `^8.0.7`). Examples are workspaces (`examples/*` in root package.json). `bun test:examples` runs `scripts/test-examples.ts`.

---

## 5. The dev-mode story (`alchemy dev`)

- CLI: `packages/alchemy/src/Cli/commands/dev.ts` (`devCommand`, registered in `Cli/main.ts`). It re-execs the user's `alchemy.run.ts` under `bun --watch` (or `node --watch`) with `ALCHEMY_DEV=true` and an RPC spawner URL; providers then run with `AlchemyContext.dev === true` (`packages/alchemy/src/AlchemyContext.ts`).
- Provider selection: `WorkerProvider() = ProviderLayer.select({ live: LiveWorkerProvider, local: LocalWorkerProvider })` — dev mode picks `LocalWorkerProvider` (`packages/alchemy/src/Cloudflare/Workers/LocalWorkerProvider.ts`, 981 lines), wired through `packages/alchemy/src/Cloudflare/Local.ts` / `LocalRuntime.ts`.
- `LocalWorkerProvider` uses **`@distilled.cloud/cloudflare-runtime`** (`Runtime.start` on workerd, `WorkerProxy` stable-URL proxy per worker id, default port 1337) — yes, cloudflare-runtime IS the local dev engine:
  - Non-vite workers: `runWorker` — `WorkerBundle.watch` (rolldown watch) streams rebuilds into `runtime.start({ modules, bindings, durableObjectNamespaces, queueConsumers, assets })`; the proxy queues requests during rebuilds.
  - **Vite workers (`props.vite`)**: `runVite(config, rootDir)` — lazily imports `Workers/Vite.ts` and calls `viteDev(rootDir, env, pluginOptions, { port: 0 })` which spins up a **real `vite.createServer`** with `cloudflare(pluginOptions)` injected, passing `worker: { name, bindings, durableObjectNamespaces, hyperdrives, queueConsumers, assets }` + the runtime `context` so the framework's HMR dev server runs inside the plugin's workerd environment with real Alchemy-managed bindings. The proxy then fronts `devServer.resolvedUrls.local[0]`.
  - Binding translation: `toRuntimeBinding` maps every `WorkerBinding` wire type to a cloudflare-runtime hook — `local` for emulatable ones (DO, queue, hyperdrive, ratelimit, text/json, assets, workflow) and `remote` for cloud-backed ones (r2, kv, d1, ai, browser, images, vectorize, dispatch_namespace, ...). Unsupported: `inherit`, `secret_key`, `secrets_store_secret`.
  - Restart logic: `structuralSignature` (canonical-JSON sha256 of `{id, props, bindings}`) decides reuse vs teardown; `diff` returns `noop` when unchanged.
  - `dev: { mode: "external", url }` (what StaticSite sets when `props.dev.command` exists): the local provider tears down/never starts workerd and returns stub attributes with the external URL — the framework's own dev server (spawned by `Command.Dev`) serves everything.
- StaticSite dev = external `Command.Dev` process; Website.Vite dev = in-process Vite dev server via cloudflare-vite-plugin. **This is the fork every new framework resource must choose per framework** (Vite-based frameworks — Astro, SvelteKit, Waku — can ride the Vite path; Next.js cannot and would use the external-command path, like StaticSite, wrapping `next dev`).
- Example: `examples/cloudflare-dev/` exercises dev mode; `packages/alchemy/test/Cloudflare/Website/Vite.test.ts` line 778 (`devTest.provider`, `Test.make({ providers, dev: true })`) is a live dev-mode test proving HMR + Alchemy-managed R2 bindings + stable proxy URL across redeploys.

---

## 6. What adding `Cloudflare.Website.{Nextjs,Astro,SvelteKit,Waku}` structurally requires

### Files

```
packages/alchemy/src/Cloudflare/Website/Nextjs.ts      # (and Astro.ts / SvelteKit.ts / Waku.ts)
packages/alchemy/src/Cloudflare/Website/index.ts       # add: export * from "./Nextjs.ts"; etc.
packages/alchemy/test/Cloudflare/Website/Nextjs.test.ts
packages/alchemy/test/Cloudflare/Website/nextjs-fixture/   # per-suite fixture project (own package.json, minimal app)
examples/cloudflare-nextjs/                             # currently empty placeholder — alchemy.run.ts + app + package.json (scripts: alchemy dev/deploy/destroy)
```

`Cloudflare/index.ts` already does `export * as Website from "./Website/index.ts"` (line 100) — no change needed there beyond the Website barrel.

### No provider registration

Follow `Vite.ts`/`StaticSite.ts`: implement as a composite that returns `Worker(...)` (optionally preceded by `Command.Build`/`Command.Dev` under `Namespace.push(id)`). `Providers.ts` needs **no** edit — `Workers.WorkerProvider()` and `Command.providers()` are already registered. (Only if a framework genuinely needs a new Resource type would the nested-`Layer.mergeAll` registration discipline from AGENTS.md apply.)

### Implementation shape choices (per framework)

- **Vite-based frameworks (Astro, SvelteKit, Waku)**: prefer delegating to the `props.vite` path (like `Website.Vite`) so build AND dev-HMR-with-bindings come for free. Key knobs: `viteEnvironments` (`entry`/`children` — Waku/RSC frameworks may need `{ entry: "rsc", children: ["ssr"] }`), `vite.main` for custom entries, `assets` config, `nodejs_compat` flag. Verify each framework's Vite environment names against `cloudflare-tools/upstream/{astro,sveltekit,waku}` and the plugin's `parseViteEnvironments` (`cloudflare-tools/packages/cloudflare-rolldown-plugin/src/options.ts`; `client` is reserved). Frameworks whose adapters emit their own worker entry may instead need the StaticSite-style `Command.Build` + prebuilt-output path.
- **Nextjs**: no Vite. Expected shape = `Command.Build` running `opennextjs-cloudflare build` (see `cloudflare-tools/upstream/opennextjs-cloudflare`), then `Worker` with `{ main: ".open-next/worker.js", bundle: false, assets: ".open-next/assets" (as AssetsWithHash with the build hash), rules?: ModuleRule[] }` — the documented prebuilt contract in `Worker.ts`. Dev mode = `Command.Dev` (`next dev`) + `dev: { mode: "external", url }`, exactly like StaticSite's `dev` prop.
- Follow the overload dance from `StaticSite.ts` for the class form: `<Self>(): (id, props) => Effect & { new(): Worker<NormalizedBindings<Bindings, WorkerAssetsConfig>> }` implemented with `effectClass(make...)`, value form via a shared `make{Framework}` helper. Props should `Omit` the internal Worker props (`vite`, and `assets`→`AssetsConfig` re-add, `dev` replacement) exactly as the existing two do. Never use `Input<T>` in declared props (AGENTS.md rule).

### Docs (JSDoc conventions)

Generated by `bun generate:api-reference` (`scripts/generate-api-reference.ts`) into `website/src/content/docs/providers/Cloudflare/Website/{Resource}.md` — never hand-edit those. On the exported `const`:
- `@resource`, `@product Website`, `@category Workers & Compute` (copy from `Vite.ts` lines 35–37).
- `@section <Title>` + `@example <Title>` pairs, simplest first; include a "Class Form" section (both existing files have one).
- Field-level JSDoc on every prop, `@default` where applicable.

### Tests (`packages/alchemy/test/Cloudflare/Website/`)

Follow `Vite.test.ts` (1130 lines) / `StaticSite.test.ts` (604 lines):
- `const { test } = Test.make({ providers: Cloudflare.providers() })`; dev-mode suite via `Test.make({ providers, dev: true })`.
- `test.provider("...", (stack) => Effect.gen(...))` with explicit `stack.destroy()` at start and end; per-test timeouts ≤ 120s where possible (live deploys use up to 180s).
- Fixtures live in sibling dirs (`vite-fixture/`, `vite-spa-fixture/`, `vite-do-fixture/`, `react-router-rsc-fixture/`, `tanstack-dev-bindings-fixture/`, `staticsite-fixture/`); tests **clone** them into `packages/alchemy/.tmp/` via `cloneFixture` (`test/Cloudflare/Utils/Fixture.ts`) before mutating files (Vite requires the root under cwd — see the `tempRoot` comment in `Vite.test.ts` line ~47).
- Assert content-hash behavior (`site2.hash.input !== site1.hash.input` after an edit; unchanged input → same hash / no redeploy), out-of-band verification via `expectWorkerExists`/`waitForWorkerToBeDeleted` (`test/Cloudflare/Utils/Worker.ts`), URL polling via `expectUrlContains` (`test/Cloudflare/Utils/Http.ts`) with bounded schedules.
- Restrict `memo.include` to fixture files so the test doesn't hash the whole monorepo.
- Run: `timeout 240 bun run test test/Cloudflare/Website/Nextjs.test.ts --profile testing` (speed doctrine per AGENTS.md; framework builds are slow — budget timeouts accordingly and `skipIf`-gate anything slower than ~3–5 min).

### Framework build knowledge sources

- `cloudflare-tools/upstream/{next.js, opennextjs-cloudflare, astro, sveltekit, waku}` — vendored upstream repos.
- `cloudflare-tools/fixtures/*` — working vite-plugin fixture apps (tanstack-start, solidstart, react-router-rsc, solid-ssr, static-website).
- `packages/alchemy/test/Cloudflare/Website/react-router-rsc-fixture` — in-tree RSC reference (multi-environment `viteEnvironments: { entry: "rsc", children: ["ssr"] }`).
