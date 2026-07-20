# cloudflare-tools internals — onboarding spec for framework-integration agents

Repo: `/Users/john/Developer/Alchemy/alchemy-effect/cloudflare-tools` (bun workspace monorepo, `packageManager: bun@1.3.13`).

Audience: agents integrating web frameworks (Next.js, Astro, SvelteKit, Waku, OpenNext, …) as new
fixtures and/or adapters. All paths below are repo-relative unless absolute. Everything is
Effect-native (`effect` v4 beta line, `catalog:effect`), and there is **no wrangler.json anywhere** —
all worker configuration is programmatic.

Package map:

| Package | npm name | Role |
| --- | --- | --- |
| `packages/cloudflare-rolldown-plugin` | `@distilled.cloud/cloudflare-rolldown-plugin` | Bundler-level plugins (entry wrapping, node compat, wasm, module rules). Works in raw Rolldown *and* Vite. |
| `packages/cloudflare-runtime` | `@distilled.cloud/cloudflare-runtime` | Effect-native local runtime that spawns `workerd` directly (no miniflare, no wrangler). |
| `packages/cloudflare-vite-plugin` | `@distilled.cloud/cloudflare-vite-plugin` | Vite plugin: composes the rolldown plugins + cloudflare-runtime dev server. |
| `packages/tools/e2e` | `@distilled.cloud/e2e` (private) | Internal CLI + Playwright harness driving fixtures (`e2e dev/build/preview`). |
| `packages/tools/build` | `@distilled.cloud/build-utils` (private) | `worker:` import scheme plugins for tsdown/vitest. |
| `packages/tools/test` | `@distilled.cloud/test-utils` (private) | Thin miniflare wrapper used by e2e `preview` and unit tests. |
| `packages/vendor/*` | `@distilled.cloud/vendor-workers-shared`, `-workflows-shared` | Vendored `cloudflare/workers-sdk` internals (asset config/manifest code). |
| `fixtures/*` | `@fixtures/*` (private) | Framework integration fixtures with Playwright smoke tests. |
| `upstream/*` | git submodules | `workers-sdk`, `next.js`, `astro`, `sveltekit`, `waku`, `opennextjs-cloudflare` — reference source only. |

---

## 1. `packages/tools/e2e` — the fixture harness

Private package `@distilled.cloud/e2e`. `package.json` (`packages/tools/e2e/package.json`):

- `bin: { "e2e": "./src/Cli.ts" }` — fixtures run the CLI straight from TS source (`#!/usr/bin/env node`, Node 24 type-stripping; `bun run src/Cli.ts` also works via the `e2e` script).
- `exports`: `"./Options" → src/Options.ts`, `"./Playwright" → src/Playwright.ts`, and `"./Harness" → ./src/Harness.ts` — **note: `src/Harness.ts` does not exist**; the `./Harness` export is stale. Do not import it.
- deps: `effect`, `@effect/platform-node`; devDeps: `@distilled.cloud/cloudflare-vite-plugin`, `@distilled.cloud/test-utils`, `@playwright/test`, `vite`.

### 1.1 `src/Options.ts` — the `e2e.config.ts` contract

```ts
export interface Options {
  readonly vite: CloudflareVitePluginOptions;        // from @distilled.cloud/cloudflare-vite-plugin
  readonly miniflare: Options.MiniflareOptions;      // miniflare options for `preview`
}
namespace Options {
  type Input = Options | Effect.Effect<Options>;
  type MiniflareOptions = { [K in keyof Miniflare.Options]?: K extends "assets"
      ? Omit<Miniflare.Options[K], "directory">      // directory injected from the build output
      : Miniflare.Options[K] };
}
export const make = (options: Options.Input) => ...   // brands with a Symbol so load() can validate
export const load = Effect.fn(function* () { ... })    // dynamic-imports `<cwd>/e2e.config.ts`
```

- `load()` resolves `e2e.config.ts` against `Runtime.Cwd` (a `Context.Reference` defaulting to
  `process.cwd()`), imports its **default export**, and accepts either a plain branded `Options`
  object or an `Effect<Options>` (the tanstack fixture returns
  `Config.string("TEST_POSTGRES_URL").pipe(Effect.map(url => Options.make({...})))`, so env config
  participates in the Effect config system — `Runtime.layer` installs
  `ConfigProvider.fromDotEnv() orElse fromEnv()`).
- Missing/unbranded config throws `"No e2e.config.ts found"`.

### 1.2 `src/Vite.ts` — the `Vite` service and `BuildOutput`

```ts
export class ViteError extends Data.TaggedError<"ViteError">("ViteError")<{ message; cause? }> {}

export interface BuildOutput {
  clientDirectory: string | undefined;   // absolute path to the built client assets dir
  serverModules: Array<OutputFile> | undefined; // { name, content, hash } — entry module FIRST
  externalWorkspaces: Set<string>;       // package roots of modules imported from outside the app root
}

export class Vite extends Context.Service<Vite, {
  build(pluginOptions?: CloudflareVitePluginOptions, config?: vite.InlineConfig): Effect<BuildOutput, ViteError>;
  dev(pluginOptions?: CloudflareVitePluginOptions, config?: vite.InlineConfig):
      Effect<{ url: string; server: vite.ViteDevServer }, ViteError, Scope.Scope>;
  readBuildOutput(): Effect<BuildOutput, PlatformError>;
}>()("@alchemy/Vite") {}
export const ViteLive = Layer.effect(Vite, ...);
```

Key behaviors of `ViteLive`:

- **Vite module loading** (`load`): resolves `vite` from the *fixture's* `node_modules` via
  `createRequire(path.resolve(root, "package.json")).resolve("vite")` + `pathToFileURL` import,
  falling back to a bare `import("vite")`. This lets each fixture pin its own Vite version.
- **`build`**: `vite.createBuilder(config + [userPlugins..., cloudflareVitePlugin(pluginOptions), output(...)], null)`
  then `builder.buildApp()`. A private `output` plugin (`name: "alchemy:build-output"`,
  `sharedDuringBuild: true`) accumulates into an `OutputAcc`:
  - `configResolved` records `distDirectory` (root outDir).
  - `writeBundle` per environment:
    - collects `externalDirectories` — module ids that are absolute, non-`node_modules`, and outside
      the environment root (basis for `externalWorkspaces`, later resolved by a cached `findUp`
      over `package.json`). This is how monorepo workspace deps are detected.
    - `client` environment → sets `clientDirectory` and returns.
    - every server environment → each emitted file becomes an `OutputFile`
      (`name` prefixed with the outDir relative to `distDirectory`; content = chunk code or asset
      source; sha256 `hash`).
    - the entry chunk of the environment named by `pluginOptions.viteEnvironments?.entry`
      (**default `"ssr"`**) is recorded as `serverEntry`; throws `"Server entry not found"` if the
      entry environment produced no entry chunk.
    - **RSC special case**: `@vitejs/plugin-rsc` writes `__vite_rsc_assets_manifest.js` and
      `__vite_rsc_env_imports_manifest.js` to disk after the build instead of emitting chunks
      (`RSC_MANIFEST` map, virtual ids `virtual:vite-rsc/assets-manifest` /
      `virtual:vite-rsc/environment-imports`); when a chunk imports those ids the files are read
      from the outDir and added to `serverModules`.
  - `collectServerModules` sorts modules with **`serverEntry` first**, remainder lexicographic —
    consumers treat `serverModules[0]` as the worker main module.
  - The result is serialized to **`<cwd>/dist/build.json`** and also returned.
- **`dev`**: `vite.createServer(config + [userPlugins..., cloudflareVitePlugin(pluginOptions)])` →
  `server.listen()`, wrapped in `Effect.acquireRelease` (close on scope end). Returns
  `{ url: server.resolvedUrls.local[0], server }`.
- **`readBuildOutput`**: reads `dist/build.json`, reviving `{ type: "Buffer", data }` JSON nodes to
  `Buffer` (so wasm/binary server modules round-trip).

### 1.3 `src/Runtime.ts` — layer + main runner

- `Cwd` — `Context.Reference("@distilled.cloud/e2e/Cwd", () => process.cwd())`.
- `layer = Server.layer |> provideMerge(Vite.ViteLive) |> provideMerge(ConfigProvider dotenv→env) |> provideMerge(NodeServices.layer)`.
- `runMain(effect)` — creates an unsafe `Scope`, runs via `NodeRuntime.runMain`, closes the scope in
  `teardown` (so acquired servers/processes shut down on SIGINT).

### 1.4 `src/Server.ts` — `Server` service (`live` vs `dev`)

```ts
export interface Instance { url: URL; fetch/fetchText/fetchJson; dispose(): Promise<void>; }
export class Server extends Context.Service<Server, {
  live(): Effect<Instance.Raw, Vite.ViteError, Scope.Scope>;
  dev():  Effect<Instance.Raw, Vite.ViteError, Scope.Scope>;
}>()("@distilled.cloud/e2e/Server") {}
```

- `live()` — **the built-output path**: `vite.readBuildOutput()` with `Effect.catch(() => vite.build(options.vite))`
  (i.e. auto-build when `dist/build.json` is missing). Converts `BuildOutput.serverModules` to
  miniflare `MiniflareModule`s using `moduleTypeFromExtension` (from
  `@distilled.cloud/test-utils/miniflare-module`; source maps dropped), then
  `Miniflare.createMiniflare({ ...options.miniflare, assets: {...options.miniflare.assets, directory: build.clientDirectory}, modules })`
  wrapped with `Effect.acquireDisposable`. **Important: `live`/`preview` currently runs against
  *miniflare* (`packages/tools/test/src/miniflare.ts`), not against `cloudflare-runtime`** —
  miniflare acts as the production-parity check while dev runs on cloudflare-runtime's workerd.
  Because miniflare's first `modules` entry is the worker entry, the entry-first sort in
  `collectServerModules` is load-bearing.
- `dev()` — `vite.dev(options.vite)` and wraps the resolved URL with `fetch/fetchText/fetchJson`
  helpers (plain `fetch` against the Vite dev server URL).

### 1.5 `src/Cli.ts` — the `e2e` CLI

Built with `effect/unstable/cli` (`Command.make` + `Command.withSubcommands` + `Command.run`),
provided `Runtime.layer`, executed with `Runtime.runMain`:

- `e2e build` — `Options.load()` → `vite.build(options.vite)` (writes `dist/build.json`).
- `e2e dev [--port N]` — `vite.dev(options.vite, { server: { port } })`, prints URLs, `Effect.never`.
- `e2e preview` — `Server.live()` (miniflare over the built output), logs URL, `Effect.never`.

### 1.6 `src/Playwright.ts` — Playwright fixture

```ts
export const SERVER_METHODS = ["live", "dev"] as const;
export type ServerMethod = (typeof SERVER_METHODS)[number];
export const make = (method: ServerMethod) => test.extend<{}, { server: Server.Instance }>({...});
```

`make(method)` returns a Playwright `test` extended with a **worker-scoped** `server` fixture:
it builds `ManagedRuntime.make(Runtime.layer)`, runs `Server.use(s => s[method]())` under an unsafe
scope, and exposes `{ url, fetch, fetchText, fetchJson, dispose }`. Fixture test files iterate
`SERVER_METHODS` so every test runs against **both** the dev server (workerd via vite plugin) and
the live preview (miniflare over the built bundle).

### 1.7 `packages/tools/test` (`@distilled.cloud/test-utils`)

- `src/miniflare.ts`: `createMiniflare(options): MiniflareInstance` (`new Miniflare(options)`,
  `await miniflare.ready`, `dispatchFetch`-based `fetch/fetchText/fetchJson`, `Symbol.asyncDispose`)
  and `createMiniflareFromRolldown(output, options)`.
- `src/miniflare-module.ts`: `MiniflareModule` type, `miniflareModulesFromRolldownOutput`,
  `moduleTypeFromExtension(ext)` (`.wasm`→CompiledWasm, `.bin`→Data, `.mjs/.js`→ESModule,
  `.cjs`→CommonJS, `.map`→SourceMap (dropped), everything else→Text).

### 1.8 `packages/tools/build` (`@distilled.cloud/build-utils`)

`InternalWorkerExportPlugin` / `InternalWorkerImportPlugin` implement the repo's `worker:` import
scheme: `import * as W from "worker:./foo.worker.ts"` gives `{ modules: Record<string,string>, worker(): Promise<...> }`.
tsdown bundles every `src/**/*.worker.ts` into `dist/workers` (see
`packages/cloudflare-runtime/tsdown.config.ts` /
`packages/cloudflare-vite-plugin/tsdown.config.ts`); vitest configs use
`InternalWorkerImportPlugin({ workersRoot: .../dist/workers })` — hence the AGENTS.md rule
"**re-run `bun run build` after editing any internal worker**".

---

## 2. `packages/cloudflare-vite-plugin`

Entry: `src/plugin.ts`, default export `cloudflareVitePlugin(options?: CloudflareVitePluginOptions): vite.PluginOption`.

### 2.1 Public options

```ts
// src/plugin.ts
export interface CloudflareVitePluginOptions<B extends BindingHooks = BindingHooks>
  extends BasePluginOptions {
  worker?: Omit<RuntimeWorker<B>, "compatibilityDate" | "compatibilityFlags" | "modules">;
  context?: Context.Context<RuntimeServices>;   // pre-built runtime services (else a default is created)
}
```

`BasePluginOptions` (`packages/cloudflare-rolldown-plugin/src/options.ts`):

- `main?: string` — worker entry override. If omitted, the entry is taken from the **entry Vite
  environment's** build input (framework-provided `environments.ssr.build.rollupOptions.input` etc.).
- `compatibilityDate?: string`, `compatibilityFlags?: Array<string>` (e.g. `["nodejs_compat"]`,
  `["nodejs_als"]`).
- `exports?: Array<string>` — restrict re-exported worker entry exports (e.g. `["default"]`; the
  solidstart fixture needs this because Nitro's entry has extra exports).
- `viteEnvironments?: { entry?: string; children?: Array<string> }` — **default `{ entry: "ssr", children: [] }`**.
  `entry` names the Vite environment that hosts the Worker; `children` are additional environments
  the worker loads at runtime. RSC apps set `{ entry: "rsc", children: ["ssr"] }` (worker runs in
  the react-server-resolved `rsc` env and loads `ssr` via `import.meta.viteRsc.loadModule`).
  `parseViteEnvironments` validates: `"client"` is forbidden anywhere, names unique, child ≠ entry.

The `worker` field is the `RuntimeWorker` **minus** `compatibilityDate/compatibilityFlags`
(taken from the plugin options) and `modules` (supplied by the module-runner in dev): so
`name`, `bindings: Array<BindingHook>`, `assets`, `hyperdrives`, `durableObjectNamespaces`,
`queueConsumers`, `unsafe` (see §3.2).

### 2.2 Plugin composition (`src/plugin.ts`)

`cloudflareVitePlugin` returns, in order:
`optionsPlugin.vite`, `cloudflareExternalsPlugin.vite`, `nodejsAlsPlugin.vite`,
`nodejsImportWarningPlugin.vite`, `nodejsUnenvPlugin.vite`, `virtualModulesPlugin.vite`,
`wasmInitPlugin.vite`, `additionalModulesPlugin.vite` (all from
`@distilled.cloud/cloudflare-rolldown-plugin/plugins`), an inline `distilled-cloudflare:rsc`
plugin that sets `{ rsc: { serverHandler: false } }` (disables `@vitejs/plugin-rsc`'s own node
server handler), and `dev(options)` from `src/dev-plugin.ts`.

What the rolldown-level plugins do (all dual `rolldown`/`vite` via `createPlugin` in
`src/factory.ts`; each vite plugin is named `distilled-cloudflare:<name>`):

- **`optionsPlugin`** (`plugins/options.ts`, exposes `OptionsApi { input(): Record<string,string> }`):
  the heart of environment wiring. In Vite `config()` it:
  - computes worker entries: `pluginOptions.main ?? defaultEnvironmentEntries(entryEnv, userConfig)`
    where `defaultEnvironmentEntries` reads
    `userConfig.environments[name].build.rolldownOptions?.input ?? rollupOptions?.input`.
    **This is the SSR-entry-detection assumption: the framework plugin must declare its server
    entry as the build input of the entry environment (default `ssr`), or the integrator passes
    `main` explicitly.** Inputs are normalized (string/array/record) and path-resolved against the
    Vite root; each is wrapped as a virtual id `\0distilled:worker-entry:<abs path>`.
  - sets `appType`: `"custom"` when there are inputs, `"spa"` when none (pure static site) — and
    provides a default `builder.buildApp` that builds every environment not already built (some
    frameworks don't supply one).
  - for every worker environment (entry + children): `resolve.noExternal: true`,
    conditions `["workerd","worker","module","browser","development|production"]`, mainFields/extensions
    defaults, `keepProcessEnv: true`, `optimizeDeps` configured for workerd resolution (rolldown-vite
    and esbuild variants), and `define`s that bake `process.env.NODE_ENV` (and, without
    `nodejs_compat`, empty `process.env`; `navigator.userAgent = "Cloudflare-Workers"` for
    compat-date ≥ 2022-03-21; `import.meta.hot: false` in production).
  - only the **entry** environment gets `build: { ssr: true, emitAssets, copyPublicDir: false, outDir: dist/<envName>, rollupOptions: { input: wrappedInput, preserveEntrySignatures: "strict" } }`;
    children keep the framework's own build config. `client` env outDir defaults to `dist/client`.
- **`virtualModulesPlugin`** (`plugins/virtual-modules.ts`): loads
  `\0distilled:worker-entry:*` as a wrapper module that re-exports the user entry
  (`export { <exports> } from ...` when `options.exports` is set, else
  `export *` + `export default userEntry.default ?? {}`), prepends unenv polyfill/inject imports,
  and in dev registers an `import.meta.hot.accept` handler that sends export-type metadata
  (`WorkerEntrypoint` / `DurableObject` / `WorkflowEntrypoint` classification) over HMR
  (`distilled-cloudflare:worker-export-types`).
- **`additionalModulesPlugin`** (`plugins/additional-modules.ts`): implements Cloudflare module
  rules — `.wasm(?module)` → `CompiledWasm`, `.bin` → `Data`, `.txt/.html/.sql` → `Text`. Resolved
  ids become external references `__CLOUDFLARE_MODULE__<Type>__<path>__CLOUDFLARE_MODULE__`
  (`MODULE_REFERENCE_REGEX`); at build time `renderChunk`/`generateBundle` rewrite them to emitted
  module files; in dev a `hotUpdate` triggers a full server restart when such a file changes.
- **`wasmInitPlugin`**: supports Vite's `?init` wasm convention by generating an
  `WebAssembly.instantiate(wasmModule, imports)` wrapper over the imported wasm module.
- **`cloudflareExternalsPlugin`**: externalizes `cloudflare:email|node|sockets|workers|workflows`
  (declared as `resolve.builtins` for worker envs; excluded from client optimizeDeps because
  frameworks mix client/server code pre-extraction).
- **`nodejsUnenvPlugin` / `nodejsAlsPlugin` / `nodejsImportWarningPlugin`** (`plugins/nodejs-compat.ts`):
  unenv-based `node:*` handling keyed off `compatibilityFlags` (`hasNodejsCompat`); ALS-only mode
  for `nodejs_als`; warnings when node builtins are imported without compat.

### 2.3 The dev server (`src/dev-plugin.ts` + `src/dev-server.ts` + `src/dev-environment.ts`)

`dev(options)` (vite plugin `distilled-cloudflare:dev`):

- `config()` registers each worker environment name with
  `dev.createEnvironment = (name, config) => new DistilledDevEnvironment(name, config)`.
- `configureServer(server)`:
  1. Resolves `optionsApi.input()`; **exactly one entry input is enforced** (>1 throws).
  2. Builds the runtime context: `options.context ?? createDefaultContext()` (module-level cached).
     `createDefaultContext()` = `RuntimeServices.layerRuntime({ api: { accountId: process.env.CLOUDFLARE_ACCOUNT_ID! } })`
     provided with BunServices-or-NodeServices + `Credentials.fromEnv()` + `FetchHttpClient.layer`,
     built into a `Context` with an unsafe scope. (So remote bindings use
     `CLOUDFLARE_ACCOUNT_ID` + credentials env vars; a host tool can instead inject its own
     `context` via plugin options.)
  3. `startServer(options, { environmentName: entryEnv, entryId: input, entryName: input }, server, context)`
     (from `dev-server.ts`) — starts a **workerd** instance via `Runtime.start` with:
     - modules: a synthesized `index.worker.mjs` that wraps everything through
       `module-runner/wrapper.worker.ts` (`createWorkerEntrypointWrapper("default")`, re-exports
       `ModuleRunnerDO`, and one `createDurableObjectWrapper(className)` per configured DO
       namespace) + the bundled `module-runner.worker.ts` / `wrapper.worker.ts` internal workers.
     - bindings: `UnsafeEval.local("__DISTILLED_UNSAFE_EVAL__")`,
       `DurableObjectNamespace.local({ binding: "__DISTILLED_MODULE_RUNNER__", className: "ModuleRunnerDO" })`,
       `Json.local("__DISTILLED_ENVIRONMENT__", entryEnvironment)`,
       `Loopback.local({ binding: "__DISTILLED_INVOKE_MODULE__", ... })` whose handler forwards
       Vite `CustomPayload` invokes to `server.environments[env].hot.handleInvoke` — this is the
       module-transport bridge — plus `...options.worker.bindings`.
     - DO namespaces: `{ className: "ModuleRunnerDO", sql: false, ephemeralLocal: true }` +
       `options.worker.durableObjectNamespaces`.
     - `hyperdrives`, `assets` from `options.worker`; `compatibilityDate` default `"2026-05-12"`.
     - `unsafe.moduleFallback`: a local HTTP service (`makeModuleFallbackService`) that serves
       `__CLOUDFLARE_MODULE__...` ids from disk as workerd module-fallback responses
       (CompiledWasm/Data/Text) — how wasm/bin/text modules load in dev.
     - Assets in dev are provided by `Effect.provide(ViteAssets.ViteAssetsLive(server))`
       (`src/assets/ViteAssets.ts`): replaces the disk-manifest `Assets` plugin with a vite-aware
       asset worker whose HTML existence/content lookups loop back into the dev server
       (`transformIndexHtml`, publicDir handling) via Loopback routes — so HMR and virtual HTML work.
  4. Each `DistilledDevEnvironment` connects a WebSocket to the workerd address at
     `INIT_PATH = "/__vite_module_runner/init"` with header
     `ENVIRONMENT_NAME_HEADER = "distilled-environment-name"`; the environment's `HotChannel` rides
     that socket, and `fetchModule` externalizes `__CLOUDFLARE_MODULE__` ids (native `import()` →
     module fallback). A Vite **module runner** inside the `ModuleRunnerDO` executes the entry
     environment's modules in workerd.
  5. In SPA mode (no input) requests are *not* proxied. Otherwise a post-middleware forwards every
     Vite HTTP request to the workerd address via `node:http` (host header rewritten by
     `resolveForwardedHost`, `src/forwarded-host.ts`), and `handleWebSocket(server.httpServer, address)`
     (`src/websockets.ts`) proxies WS upgrades.
- Server restarts (`server.restart`) are wrapped so `buildEnd`/`closeBundle` don't tear down the
  workerd handle mid-restart; otherwise `close()` disposes it.

Framework assumptions summary (what a new framework must satisfy):

1. Server entry discoverable: either the framework sets `environments[<entry>].build.rollupOptions.input`
   (default entry env `ssr`) or the fixture passes `main` in plugin options.
2. Exactly one server entry module in dev.
3. The worker entry default-exports a fetch handler (or named exports listed in `exports`).
4. Client assets end up in the `client` environment (build → `dist/client`); everything else is a
   worker environment declared via `viteEnvironments`.
5. RSC frameworks: `@vitejs/plugin-rsc` must run with `serverHandler: false` (the plugin forces
   this) and use `viteEnvironments: { entry: "rsc", children: ["ssr"] }`.

Tests: `packages/cloudflare-vite-plugin/test/{forwarded-host,websockets}.test.ts` (vitest).

---

## 3. `packages/cloudflare-runtime` — programmatic local workerd

This is what a **non-vite** framework integration (e.g. an OpenNext/Next standalone dev-preview)
calls to serve a built worker bundle + assets + bindings locally. No wrangler.json: config is a
plain `RuntimeWorker` object; workerd receives a binary capnp config on stdin.

Public surface (`src/index.ts` re-exports `PluginContext`, `Runtime`, `RuntimeError`,
`RuntimeServices`, `RuntimeWorker`; deep exports for every binding module — see
`package.json#exports`, e.g. `@distilled.cloud/cloudflare-runtime/bindings/KvNamespace`).

### 3.1 `Runtime` (`src/Runtime.ts`)

```ts
export class Runtime extends Context.Service<Runtime, {
  start: <B extends BindingHooks>(worker: RuntimeWorker<B>)
    => Effect<URL, RuntimeError, BindingRequirements<B> | Scope.Scope>;
}>()("cloudflare-runtime/Runtime") {}
export const RuntimeLive: Layer<Runtime, never, Workerd | Storage | Docker | Globals-plugins>;
```

`start(worker)`:
1. Builds a `PluginContext` from all plugin services in the ambient Effect context
   (services whose key starts with `cloudflare-runtime/plugin/` — see `PluginContext.pickPluginsFromContext`).
2. Runs every `BindingHook` in `worker.bindings` (each yields a workerd `Worker_Binding`).
3. Collects each plugin's contributed `services` / `sockets` / `extensions` / `middlewares`
   (middlewares are chained in `order`, each bound to the next via `upstreamBindingName`, ending at
   the user worker — this is how the asset router sits in front of the user worker).
4. Prepares containers (Docker build/pull for DO-attached `container` images; unsupported on Windows).
5. Calls `workerd.serve(config, { "debug-port": "127.0.0.1:0" })` with a socket
   `SOCKET_USER_ENTRY → 127.0.0.1:0` targeting the middleware chain head (or the user worker), the
   user worker service (`compatibilityDate/Flags`, resolved bindings, modules via `moduleToWorkerd`,
   DO namespaces with `durableObjectStorage.localDisk`, `containerEngine`, spread `worker.unsafe`),
   and plugin services/extensions.
6. Returns `new URL("http://127.0.0.1:<assigned port>")`. Everything is scoped: closing the scope
   kills workerd (plus an `exitHook` for hard exits).

### 3.2 `RuntimeWorker` (`src/RuntimeWorker.ts`) — the "config file"

```ts
export interface RuntimeWorker<B extends BindingHooks = BindingHooks> {
  name: string;
  compatibilityDate: string;
  compatibilityFlags: Array<string>;
  bindings: B;                                   // Array<BindingHook<R>>
  modules: ReadonlyArray<Module>;                // { name, type: "ESModule"|"CommonJsModule"|"Text"|"Json"|"PythonModule"|"PythonRequirement", content: string } | { type: "Data"|"Wasm", content: Uint8Array }
  assets?: Assets;                               // { directory?, headers?, redirects?, htmlHandling?, notFoundHandling?, runWorkerFirst?, serveDirectly? }
  hyperdrives?: Record<string, HyperdriveOrigin>;
  durableObjectNamespaces?: ReadonlyArray<DurableObjectNamespace>; // { className, sql, uniqueKey?, ephemeralLocal?, container? }
  queueConsumers?: ReadonlyArray<QueueConsumer>;
  unsafe?: Partial<WorkerdConfig.Worker>;        // raw workerd worker config escape hatch (e.g. moduleFallback)
}
```

The **first module** whose type is an entry (in practice `modules[0]`) is the worker main module.
`Assets.directory` + the `Assets` plugin build a static-asset manifest and router middleware
(vendored from workers-sdk; `src/bindings/assets/Assets.ts`, `Assets.buildAssetConfigs`).

### 3.3 `RuntimeServices` (`src/RuntimeServices.ts`) — batteries-included layer

```ts
export interface RuntimeConfig { api: { accountId: string | Effect<string> }; storage?: { directory: string }; }
export const layerRuntime: (config: RuntimeConfig) => Layer<RuntimeServices, ..., Credentials | HttpClient | platform>;
export type RuntimeServices = Runtime | BindingServices; // BindingServices = AnalyticsEngine|Assets|DispatchNamespace|Hyperdrive|Loopback|Queue|RateLimit|RemoteBindings|RegistryProxy|SendEmail|Workflows
```

`layerRuntime` composes `RuntimeLive` + `layerLocalBindings()` (AnalyticsEngine, Assets,
DispatchNamespace, Hyperdrive, Queue, RateLimit, SendEmail, Workflows) +
`layerRemoteBindings(config.api)` + `WorkerProxy` + `Globals` + Loopback server + Storage
(disk dir or temp) + Internet + dev Registry (+proxy) + Paths + Docker + Workerd. Requirements you
must provide: platform services (`NodeServices.layer` or `BunServices.layer`),
`Credentials` (`@distilled.cloud/cloudflare/Credentials.fromEnv()`), and an `HttpClient`
(`FetchHttpClient.layer`). See `createDefaultContext` in
`packages/cloudflare-vite-plugin/src/dev-server.ts` for the canonical composition, and
`localRuntimeLayer` in `packages/cloudflare-runtime/test/helpers/runtime.ts` for a
**credentials-free** variant (excludes RemoteBindings; safe for purely local bindings).

Minimal non-vite usage (the pattern a framework preview server would follow — from
`test/Runtime.test.ts` / `test/helpers/runtime.ts#startTestWorker`):

```ts
const runtime = yield* Runtime.Runtime;
const url = yield* runtime.start({
  name: "my-app",
  compatibilityDate: "2026-03-10",
  compatibilityFlags: ["nodejs_compat"],
  bindings: [Text.local("SECRET", "..."), KvNamespace.remote("KV", namespaceId)],
  modules: [{ name: "index.mjs", type: "ESModule", content: bundledCode }, ...chunks, ...wasm],
  assets: { directory: "dist/client", htmlHandling: "auto-trailing-slash", notFoundHandling: "none" },
});
// fetch(new URL("/", url)) ...
```

### 3.4 Bindings — `BindingHook` factories (`src/bindings/*`)

A binding is `BindingHook<R> = Effect<WorkerdConfig.Worker_Binding, ConfigError, R | PluginContext>`.
Local vs remote per module:

- Trivial locals: `Text.local(name, text)`, `Json.local(name, value)`, `Data.local`,
  `WasmModule.local`, `UnsafeEval.local(name)`, `VersionMetadata`, …
- `DurableObjectNamespace.local({ binding, className, scriptName?, uniqueKey? })` — same-worker DO
  binding, or cross-process via the dev registry when `scriptName` names another running dev worker.
- `Service.local({ binding, scriptName, entrypoint?, props? })` — cross-process service binding via
  the on-disk **dev registry** (interops with `wrangler dev` processes);
  `Service.remote(name, service)` — deployed worker via remote-bindings proxy.
- `Loopback.local({ binding, name, handler })` — bind an Effect `RouteHandler` running in Node as a
  service the worker can `fetch` (used heavily by the vite plugin and asset workers).
- Remote-only resources: `KvNamespace.remote(binding, namespaceId)`,
  `R2Bucket.remote(binding, bucketName, jurisdiction?)`, `D1.remote(binding, id)`, `Ai`, `Browser`,
  `Images`, `Vectorize`, `Pipelines`, `AiSearch`, `MtlsCertificate`, `Media`, etc. — all via
  `makeRemoteBinding` (below).
- Plugin-backed locals with their own workers: `analytics-engine`, `queue`
  (`queueConsumers` + producer bindings), `rate-limit`, `send-email`, `workflows`,
  `dispatch-namespace`, `hyperdrive` (`worker.hyperdrives` record), `assets`.

**Remote bindings** (`src/remote-bindings/`): `makeRemoteBinding(binding, f)` registers a
`RemoteBinding` (the raw Cloudflare API binding JSON, `raw: true`) with the `RemoteBindings` plugin,
which deploys a **preview session worker** to the user's account via
`@distilled.cloud/cloudflare/workers` APIs (`RemoteWorker.deploy`: subdomain edge preview session +
`createScriptEdgePreview`) and wires a client/outbound worker pair inside workerd so the local
worker's binding calls tunnel to the deployed preview (mirrors wrangler's "remote bindings").
Requires `accountId` (from `RuntimeConfig.api`) + `Credentials` + `HttpClient`. CI drives these via
`CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` and `TEST_KV_NAMESPACE_ID`, `TEST_R2_BUCKET_NAME`,
`TEST_D1_DATABASE_ID`, `TEST_SERVICE_WORKER_NAME` secrets (`.github/workflows/ci.yml`).

### 3.5 workerd invocation (`src/workerd/`)

`Workerd` service (`src/workerd/Workerd.ts`) spawns the `workerd` binary (npm `workerd` package,
`catalog:workers`) as `workerd serve --binary --experimental --control-fd=3 -`, writing the config —
a TS mirror of workerd's capnp schema (`src/workerd/Config.ts`, serialized by
`internal/config.serialize.ts` via `capnp-es`) — to stdin. Ports are assigned dynamically and read
back over the control FD (`WorkerdPorts`). Kill-on-scope-close + `exitHook`. **There is no
wrangler.json / miniflare in this path at all.**

---

## 4. `fixtures/*` — the fixture pattern

Existing fixtures: `tanstack-start`, `solidstart`, `react-router-rsc`, `solid-ssr` (SPA),
`static-website` (no framework). Each is a private workspace package `@fixtures/<name>` with the
same shape. **A new framework fixture must follow this pattern.**

### 4.1 `package.json` scripts (identical across fixtures)

```jsonc
{
  "name": "@fixtures/<name>",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "e2e dev",              // optionally "e2e dev --port 3200" for a fixed port
    "build": "e2e build",          // static-website: "tsc && e2e build"
    "preview": "e2e preview",
    "test": "playwright test",
    "test:update-snapshots": "playwright test --update-snapshots",
    "pretest": "playwright install chromium"
  },
  "devDependencies": {
    "@distilled.cloud/e2e": "workspace:*",
    "@playwright/test": "catalog:",
    "vite": "catalog:"             // or the framework's pinned vite
    // + framework plugins; add "@distilled.cloud/cloudflare-runtime": "workspace:*" only if the
    //   e2e.config.ts uses binding factories (tanstack does, for Text.local)
  }
}
```

Framework deps live in `dependencies`; fixtures may pin their own Vite (solidstart uses `vite@^7`
while the catalog is `^8.1.4` — the e2e Vite loader resolves per-fixture).

### 4.2 `e2e.config.ts` shape

Default-export `Options.make({...})` or an `Effect<Options>`:

```ts
import * as Options from "@distilled.cloud/e2e/Options";

export default Options.make({
  vite: {                                     // CloudflareVitePluginOptions
    main: path.resolve(import.meta.dirname, "path/to/entry.worker.tsx"),  // only if the framework
                                              // doesn't declare the entry env's build input
    compatibilityDate: "2026-03-10",
    compatibilityFlags: ["nodejs_compat"],    // solid-ssr uses ["nodejs_als"]
    exports: ["default"],                     // only if the entry has extra exports (solidstart)
    viteEnvironments: { entry: "rsc", children: ["ssr"] },  // RSC apps only
    worker: {
      name: "fixtures-<name>",
      bindings: [],                           // e.g. [Text.local("TEST_POSTGRES_URL", url)]
      assets: { htmlHandling: "auto-trailing-slash", notFoundHandling: "none",
                runWorkerFirst: true /* tanstack */ },
    },
  },
  miniflare: {                                // preview-mode miniflare options (no assets.directory!)
    compatibilityDate: "2026-03-10",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { TEST_POSTGRES_URL: url },     // plain miniflare bindings mirror the vite worker bindings
    assets: {
      routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: false, debug: true },
      assetConfig: { html_handling: "auto-trailing-slash", not_found_handling: "none",
                     debug: true, has_static_routing: false },
    },
    // static-only fixtures (static-website, solid-ssr): has_user_worker: false plus a stub
    // modules: [{ type: "ESModule", path: "index.js", contents: "export default { fetch: () => 404 }" }]
  },
});
```

Note the duplication: the `vite` half configures dev (cloudflare-runtime) and build; the
`miniflare` half configures preview and must express the same assets/bindings semantics in
miniflare's own option names (snake_case configs). `assets.directory` is always omitted — injected
from `BuildOutput.clientDirectory` by `Server.live()`.

### 4.3 `vite.config.ts`

Plain framework config — **the cloudflare plugin is NOT in vite.config.ts**; the e2e harness
injects `cloudflareVitePlugin(options.vite)` itself. Examples:
- `fixtures/tanstack-start/vite.config.ts`: `devtools() + tailwindcss() + tanstackStart() + viteReact()`.
- `fixtures/solidstart/vite.config.ts`: `solidStart()` (Nitro-based; needs `exports: ["default"]`).
- `fixtures/react-router-rsc/vite.config.ts`: `react() + rsc({ serverHandler: false, entries: { client, ssr, rsc } })`,
  `optimizeDeps.include` for react-router server internals; worker entry passed as `main` in
  e2e.config.ts and `viteEnvironments: { entry: "rsc", children: ["ssr"] }`.
- `static-website` has **no** vite.config.ts (SPA mode: appType "spa", assets only).

(For a standalone-CLI framework like Next/OpenNext, the equivalent integration point is a custom
`e2e.config.ts`-driven build that produces the same `BuildOutput` contract, or direct use of
`cloudflare-runtime` — the e2e harness as it stands is Vite-centric.)

### 4.4 `playwright.config.ts` (copy verbatim)

`testDir: "./test"`, `timeout: 60_000`, `expect.timeout: 10_000`,
`snapshotPathTemplate: "{testDir}/__snapshots__/{testFileName}/{arg}{ext}"`, single chromium
project with `colorScheme: "light"`, `deviceScaleFactor: 1`, viewport 1280×720.

### 4.5 `test/smoke.test.ts` pattern

```ts
import * as Playwright from "@distilled.cloud/e2e/Playwright";
import { expect, test } from "@playwright/test";

for (const mode of Playwright.SERVER_METHODS) {        // ["live", "dev"]
  test.describe(mode, () => {
    const it = Playwright.make(mode);
    it("renders the homepage", async ({ page, server }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot("index.png", { animations: "disabled", maxDiffPixelRatio: 0.03 });
      // client-side nav + second screenshot ...
    });
    it("fetches database", async ({ server }) => {     // API routes exercised via server.fetchJson
      expect(await server.fetchJson("/api/db")).toMatchObject([{ "?column?": 1 }]);
    });
    it("fetches WASM", async ({ server }) => {
      expect(await server.fetchJson<{ result: number }>("/api/wasm")).toMatchObject({ result: 3 });
    });
  });
}
```

Screenshots are committed under `test/__snapshots__/smoke.test.ts/*.png`. The tanstack fixture also
exercises Postgres over `@effect/sql-pg` (env `TEST_POSTGRES_URL`, threaded through the config
Effect and bound with `Text.local` in dev / plain `bindings` in preview) and a `.wasm` module import
(`src/wasm-example.wasm`, route `src/routes/api.wasm.ts`) — good coverage targets to replicate:
SSR page render, client nav, server API route, wasm module, external service binding.

### 4.6 Fixture `tsconfig.json`

Standalone (does **not** extend `tsconfig.base.json`): bundler resolution,
`allowImportingTsExtensions`, `verbatimModuleSyntax`, `noEmit`, `types: ["vite/client", "@cloudflare/workers-types"]`,
strict. Fixtures generally have no `typecheck` script (turbo only runs scripts that exist);
`static-website` runs `tsc` inside its `build` script instead.

---

## 5. Build & CI conventions — what a new package/fixture must include

### 5.1 Workspaces & catalogs (root `package.json`)

- Workspaces: `packages/*`, `packages/vendor/*`, `packages/tools/*`, `fixtures/*`.
- Named catalog `catalog:effect` — `effect`, `@effect/platform-node`, `@effect/platform-bun`,
  `@effect/vitest`, `@effect/sql-pg` at `>=4.0.0-beta.97 || >=4.0.0`.
- Named catalog `catalog:workers` — `@cloudflare/workers-types`, `miniflare`, `workerd` (pinned wave).
- Default `catalog:` — `@playwright/test`, `vite ^8.1.4`, `vitest ^4.1.10`, `rolldown`, `tsdown`,
  `typescript ^7`, `@distilled.cloud/cloudflare`, `@alchemy.run/node-utils`.
- Always reference shared deps as `"catalog:"`/`"catalog:effect"`/`"catalog:workers"` and sibling
  packages as `"workspace:*"`.

### 5.2 turbo.json pipelines

```jsonc
{
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**", ".cache/**/*.tsbuildinfo"] },
    "dev":       { "persistent": true, "cache": false },
    "typecheck": { "dependsOn": ["^build"], "outputs": [".cache/**/*.tsbuildinfo"] },
    "test":      { "dependsOn": ["^build"], "env": ["TEST_MYSQL_URL", "TEST_POSTGRES_URL"], "outputs": [] }
  }
}
```

Root scripts: `build`/`dev` are filtered to `@distilled.cloud/*` (fixtures are excluded from build);
`test` = `turbo run test` (runs **every** package's `test` script — vitest for the plugin/runtime
packages, **Playwright for fixtures**, with `^build` ensuring the published packages are built
first); `check` = `oxfmt format --check .` + `oxlint lint . --ignore-pattern 'upstream'` +
`turbo run typecheck`. Use `bun run check:write` to auto-fix. CI (`.github/workflows/ci.yml`) runs
`bun install --frozen-lockfile`, `bun run check`, `bun run test` on ubuntu/macos/windows with the
TEST_*/CLOUDFLARE_* secrets. `pr-package.yml` publishes preview tarballs of the three published
packages to pkg.ing on PR sync.

### 5.3 What a NEW package needs

1. Directory under `packages/` (published), `packages/tools/` (internal), or `fixtures/` (fixture).
2. `package.json` with `"type": "module"`, catalog/workspace deps, and turbo-recognized scripts:
   `build` (tsc or tsdown), `dev` (watch), `typecheck` (`tsc --noEmit` or `tsc -b`), `test`
   (`vitest run`) as applicable. Fixtures: the §4.1 script set instead.
3. `tsconfig.json` extending `../../tsconfig.base.json` (base: `module: Preserve`,
   `moduleResolution: bundler`, `verbatimModuleSyntax`, `rewriteRelativeImportExtensions`,
   composite+declaration, strict, `types: ["bun"]`). Packages with internal workers split into
   `tsconfig.node.json` (checked against `@types/node`) and `tsconfig.workers.json`
   (`.worker.ts`, checked against `@cloudflare/workers-types`); `.shared.ts` files must be
   platform-neutral (see `AGENTS.md` file conventions).
4. If it ships internal workers: tsdown config with two entries (workers bundle →
   `dist/workers/*.mjs` via `cloudflare-rolldown-plugin` + `InternalWorkerExportPlugin`; node build
   → `dist/node` with `InternalWorkerImportPlugin`), and a vitest config with
   `InternalWorkerImportPlugin({ workersRoot: .../dist/workers })`, `pool: "forks"`,
   30s timeouts (see `packages/cloudflare-runtime/vitest.config.ts`; Windows serializes files).
5. Formatting/linting are repo-wide (oxfmt/oxlint, configs `.oxfmtrc.json` / `.oxlintrc.json`,
   `upstream/` ignored) — no per-package config needed. Everything must pass `bun run check`.
6. `bun install` at the root after adding the package so `bun.lock` (a turbo global dependency)
   updates.

### 5.4 Gotchas worth knowing up front

- `@distilled.cloud/e2e`'s `./Harness` export points at a nonexistent file (`src/Harness.ts`).
- `e2e preview`/`Server.live` runs **miniflare**, not cloudflare-runtime; only `e2e dev` exercises
  the workerd runtime. Both are covered per test via the `SERVER_METHODS` loop.
- `dist/build.json` is a cache: `Server.live` prefers it and only rebuilds on read failure — stale
  builds persist until you rerun `e2e build` or delete `dist/`.
- Dev-mode `.wasm`/`.bin`/`.txt/.html/.sql` imports flow through the workerd module-fallback HTTP
  service; changing such a file restarts the dev server (no HMR for them).
- `createDefaultContext` asserts `process.env.CLOUDFLARE_ACCOUNT_ID!` — remote bindings in dev need
  `CLOUDFLARE_ACCOUNT_ID` + credentials env; purely local fixtures never touch it (context is built
  lazily only in `configureServer`, but note it *is* always built — keep `bindings` local-only to
  avoid remote deploys).
- The vite plugin enforces exactly one server entry input in dev.
- After editing any `*.worker.ts` in `cloudflare-runtime`/`cloudflare-vite-plugin`, rerun
  `bun run build` (vitest and the published dist load workers from `dist/workers`).
- Windows: container-backed DOs unsupported; entry-id and path handling are POSIX-normalized in the
  plugins — keep new code path-safe.
