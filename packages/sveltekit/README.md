# @distilled.cloud/sveltekit

Wrangler-free SvelteKit integration: programmatic build and dev for SvelteKit
projects, with the deploy platform passed in as a **deploy target** value.
Cloudflare Workers is the built-in target
(`@distilled.cloud/sveltekit/cloudflare`); the framework half of this package
contains no Cloudflare code at all.

## Architecture: framework half × target half

The package follows the framework × deploy-target split defined in
`@distilled.cloud/framework-core` (see its README for the full `DeployTarget`
contract):

| Module                                                            | Role                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@distilled.cloud/sveltekit` (`src/SvelteKit.ts`, `src/index.ts`) | **Framework half.** Drives kit programmatically: loads the _project's_ `vite` and `@sveltejs/kit/vite`, synthesizes the in-memory kit config, runs `createBuilder().buildApp()` (build) / `createServer()` (dev), and implements framework-core's `Framework` service. Target-agnostic — zero Cloudflare imports, enforced by a unit test (`test/TargetDecoupling.test.ts`). |
| `@distilled.cloud/sveltekit/cloudflare` (`src/cloudflare.ts`)     | **Target half.** The Cloudflare Workers `SvelteKitTarget`: the wrangler-free in-memory kit adapter (fork of `@sveltejs/adapter-cloudflare`), the generated worker shim, the dev stub platform, and the `finish` pass that re-bundles kit's node-flavored output for workerd with rolldown + `@distilled.cloud/cloudflare-rolldown-plugin`.                                   |
| `@distilled.cloud/sveltekit/source` (`src/source.ts`)             | Alchemy Worker **source provider** (structural `WorkerSourceModule` contract): maps `Framework.build` onto alchemy's bundle/assets/hash slots, plus a rebuild-free memo hash and kit-dev `dev()`. Cloudflare-specific by nature; it passes the cloudflare target factory to the framework directly.                                                                          |

Background on why the integration is shaped this way:

- **SvelteKit is purely a Vite plugin.** There is no framework CLI for
  dev/build (`svelte-kit` only implements `sync`); `vite.createServer()` /
  `vite.createBuilder().buildApp()` are the whole programmatic API. Kit v3
  takes its entire config in-memory via `sveltekit(config)` — a
  `svelte.config.js` on disk is an upstream **error** — so the adapter
  instance and all kit options are injected programmatically.
- **Build is one `buildApp()` pass** (Vite Environment API): server build →
  route analysis → client build → prerender → (service worker) → adapter
  `adapt()`. The adapter runs _inside_ the build as a kit callback.
- **The upstream cloudflare adapter's only wrangler touchpoints** are
  `unstable_readConfig` (wrangler.json discovery) and `getPlatformProxy`
  (dev emulation) — plus, implicitly, `wrangler deploy`'s bundling of the
  emitted `_worker.js` (upstream does not bundle; its shim's relative imports
  into `.svelte-kit/output/server/**` are left for wrangler). This package
  replaces all three: plain in-memory options, a stub emulator (real proxies
  arrive with cloudflare-runtime's Node-side bindings proxy), and the rolldown
  finishing pass.

### The `SvelteKitTarget` contract

The framework half declares what any deploy target must provide:

```ts
interface SvelteKitTarget extends DeployTarget<SvelteKitTargetConfig> {
  /** Produce the kit Adapter for one build/dev invocation. */
  adapter(context: { root: string; dev?: { env?: Record<string, unknown> } }): SvelteKitAdapter;
}
```

- `adapter(context)` — a kit `Adapter` whose `adapt()` records
  `result.current = { dest, workerEntry }` (`dest` → the static-assets
  directory → `BuildOutput.clientDirectory`; `workerEntry` → the on-disk
  unbundled server entry). When `context.dev` is present the adapter's
  `emulate()` must supply the dev `platform`.
- `finish(output, context)` (generic `DeployTarget` seam) — receives
  `context.entry = workerEntry` and turns it into
  `BuildOutput.serverModules` for the target runtime.
- `build(context)` (generic seam) — optional wholesale takeover; when a
  target defines it, the framework delegates the entire production build.

`Framework.build` therefore runs: resolve target → (`target.build`? delegate)
→ kit `buildApp()` with `target.adapter({ root })` → `applyDeployTargetFinish`
with the adapter's `workerEntry`. `Framework.dev` runs kit's own Vite dev
server (Node SSR, full HMR) with `target.adapter({ root, dev })` supplying the
platform emulation. `target.serve` is not used by this package (serving built
output is the harness's/deployer's concern).

### The Cloudflare target

`makeCloudflareTarget(config)` (default export of
`@distilled.cloud/sveltekit/cloudflare`) implements the contract:

- **Adapter** — an in-memory fork of `@sveltejs/adapter-cloudflare`'s
  `adapt()`: `writeClient` + `writePrerendered` into kit's `cloudflare` build
  directory, `generateManifest` → `cloudflare-tmp/manifest.js`, generated
  `_worker.js`, merged `_headers`/`_redirects`, `.assetsignore`, optional
  `404.html`/`index.html` fallbacks, `builder.instrument` support.
  Differences from upstream: always **Workers** mode (upstream defaults to
  Pages without a wrangler config — intentional divergence), no
  `unstable_readConfig`, no `_routes.json`, and the worker shim is
  **generated with real relative import paths** (upstream ships a prebuilt
  `files/worker.js` and string-replaces `SERVER`/`MANIFEST` placeholders — no
  publish-time prebundle needed here).
- **Worker shim** — module-level `env` from `cloudflare:workers`; static
  assets, prerendered pages, and `version.json` served via the assets-binding
  fetch; trailing-slash redirects for prerendered pages; everything else
  through `server.respond` with `platform = { env, ctx, caches, cf }`.
  Upstream's `worktop/cfw.cache` dependency is replaced with an inline
  pragma-cache over `caches.default` (same lookup/save semantics, incl. the
  `private=Set-Cookie` handling).
- **Finish pass** — rolldown over the unbundled `_worker.js` (which inlines
  the whole `.svelte-kit/output/server/**` graph) into `dist/server/` with
  `cloudflare({ compatibilityDate, compatibilityFlags, exports: ["default"] })`,
  then entry-first `serverModules` via framework-core's
  `readServerModulesFromDisk`/`sortServerModules`, plus the external-workspace
  set for watch/memoization. The plugin's default resolve conditions
  (`workerd, worker, module, browser`) handle kit's node22-flavored server
  output as-is — validated end-to-end (e.g. `uuid` resolves to its browser
  entry; kit pre-inlines `esm-env` precisely so downstream bundlers don't
  mis-resolve it).
- **Dev stub platform** — `emulate()` returns `platform.env` from the
  in-memory dev env values, no-op `ctx`, a no-op `caches`, and empty `cf`.
  During prerendering, `platform.env` access throws (prerenderable routes
  must not depend on request-time bindings — mirrors upstream).

## Usage

### With the e2e harness (`e2e.config.ts`)

```ts
import * as Options from "@distilled.cloud/e2e/Options";
import * as SvelteKit from "@distilled.cloud/sveltekit";

export default Options.make({
  // string form: framework: "@distilled.cloud/sveltekit"
  framework: (options) =>
    SvelteKit.layer(SvelteKit.fromHarnessOptions(options as SvelteKit.HarnessOptions)),
  target: {
    cloudflare: {
      worker: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: {
          bindings: [
            /* ... */
          ],
          assets: { notFoundHandling: "none" },
        },
      },
      preview: {
        /* miniflare options for `e2e preview` / Playwright "live" */
      },
    },
  },
});
```

`fromHarnessOptions` reads the target-scoped carriage
(`target.cloudflare.worker`, falling back to the deprecated top-level `vite`
alias): compatibility date/flags, `assets.notFoundHandling`, and the dev stub
env derived from the declared bindings (`resolveDevEnvironment`: `Text`/`Json`
binding hooks become plain values; resource bindings are skipped).

### Direct (typed) usage

```ts
import * as SvelteKit from "@distilled.cloud/sveltekit";

const layer = SvelteKit.layer({
  compatibilityDate: "2026-03-10",
  compatibilityFlags: ["nodejs_compat"],
  kit: { alias: { $lib: "src/lib" } },
  adapter: { notFoundHandling: "404-page", fallback: "spa" },
  dev: { port: 3103, env: { MY_SECRET: "..." } },
});
```

### Selecting a deploy target

`SvelteKitOptions.target` accepts a `DeployTargetInput`:

```ts
// 1. default — omitted: resolves "@distilled.cloud/sveltekit/cloudflare"
//    from the project's node_modules
SvelteKit.layer({});

// 2. factory — applied to the config the framework assembles from options
import cloudflareTarget from "@distilled.cloud/sveltekit/cloudflare";
SvelteKit.layer({ target: cloudflareTarget });

// 3. value — full control; options-level compat/adapter fields are ignored
SvelteKit.layer({ target: cloudflareTarget({ compatibilityDate: "2026-03-10" }) });

// 4. specifier — loaded from the project's dependency tree
SvelteKit.layer({ target: "@my-scope/sveltekit-aws" });
```

A future target (e.g. AWS) implements `SvelteKitTarget` in its own module —
no change to this package's framework half.

## Options

### `SvelteKitOptions` (framework)

| Option               | Default                                                | Purpose                                                                                                                     |
| -------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `root`               | `process.cwd()`                                        | Project root. Must also be the process cwd (see limitations).                                                               |
| `target`             | `"@distilled.cloud/sveltekit/cloudflare"`              | Deploy target: value, factory, or module specifier.                                                                         |
| `compatibilityDate`  | —                                                      | Forwarded to the target config (drives the finishing pass).                                                                 |
| `compatibilityFlags` | `["nodejs_compat"]` (applied by the cloudflare target) | Forwarded to the target config. Kit's server graph is node-flavored, so `nodejs_compat` is effectively required on workerd. |
| `kit`                | —                                                      | Kit config passed to `sveltekit(config)` (the `adapter` field is injected).                                                 |
| `vite`               | —                                                      | Extra Vite `InlineConfig` merged into build/dev.                                                                            |
| `adapter`            | —                                                      | `SvelteKitAdapterOptions` forwarded to the target config.                                                                   |
| `dev.port`           | Vite default                                           | Dev-server port (overridden by `FrameworkDevOptions.port`).                                                                 |
| `dev.env`            | `{}`                                                   | Values the dev stub platform exposes as `platform.env`.                                                                     |

### `SvelteKitAdapterOptions`

| Option             | Default       | Purpose                                                                                                                               |
| ------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `assetsBinding`    | `"ASSETS"`    | Name of the static-assets binding the shim serves files through.                                                                      |
| `notFoundHandling` | `"none"`      | `"404-page"` writes `404.html`; `"single-page-application"` writes `index.html` (mirrors Workers static assets `not_found_handling`). |
| `fallback`         | `"plaintext"` | With `"404-page"`: `"spa"` renders the app shell as the fallback.                                                                     |

### `SvelteKitSourceOptions` (`./source`, alchemy)

`rootDir`, `memo` (`include`/`exclude` globs + `lockfile`, default
gitignore-aware), `kit`, `adapter` — all JSON-serializable (they persist in
alchemy state and participate in the Worker's metadata hash). `build()` maps
`BuildOutput` onto alchemy's source contract (entry-first bundle files,
manifest-hashed assets honoring `.assetsignore`/`_headers`/`_redirects`,
project-tree `input` hash); `hash()` recomputes the input hash without
building; `dev()` starts kit's dev server with the stub platform (env from the
Worker's literal env values; `Redacted` values unwrapped).

## Limitations & known constraints

- **Pre-release kit.** Pinned to `@sveltejs/kit` `3.0.0-next.9`
  (`peerDependencies: >=3.0.0-next.9`). The v3 surface this package relies on
  (`sveltekit(config)`, the `Adapter`/`Builder` API, `buildApp` ordering) is
  new and may shift before stable; treat kit bumps as deliberate migrations.
  Note the repo's `minimumReleaseAge` install gate (3 days) when bumping.
- **Always Workers mode.** Upstream defaults to Cloudflare _Pages_ when no
  wrangler config exists; this package intentionally has no Pages mode and
  emits no `_routes.json`.
- **Dev fidelity gap (phase 1).** Dev runs kit's Node SSR; `platform` is a
  stub (env values only; `caches` never hits; `cf` empty). Real KV/R2/D1/DO
  bindings in dev arrive with the cloudflare-runtime Node-side bindings proxy
  (the wrangler `getPlatformProxy` replacement per repo doctrine). Forcing
  kit's dev SSR into workerd is a non-goal (kit's dev path is hardwired to
  Node `ssrLoadModule`; even Cloudflare's official vite plugin doesn't do it).
- **cwd sensitivity.** `sveltekit()` resolves its peers
  (`@sveltejs/vite-plugin-svelte`, `vite`) and kit's postbuild
  analyse/prerender worker threads re-derive `outDir` relative to
  `process.cwd()`. Run `build` with cwd = project root. The `./source`
  provider handles this itself (a process-level lock + temporary `chdir`);
  the e2e harness runs from the fixture directory anyway.
- **Node-flavored dependencies.** Kit builds its server graph for
  `target: 'node22'`; the finishing pass re-resolves it for workerd. The
  plugin defaults have proven sufficient, but a dependency that only ships
  node builtins outside `nodejs_compat`'s coverage would surface here (the
  re-bundle's only expected externals are `cloudflare:*` and `node:*`).
- **`_headers` / `_redirects`** are read from the project root and merged with
  kit's generated rules (immutable-cache + noindex for the app dir,
  prerendered redirects).
- **Lightly-tested corners** (as upstream): service workers and
  `instrumentation.server.js` entry wrapping (supported via
  `builder.instrument`, not covered by the fixture).
- **`emulate()` env guard.** Accessing `platform.env` from a prerenderable
  route throws in dev — by design, since prerendered pages cannot see
  request-time bindings in production either.

## Testing

- `bun run test` — unit tests (adapter output generation, shim generation,
  harness-option mapping, target contract, and the import-boundary
  enforcement test).
- `fixtures/sveltekit` — the end-to-end fixture (Playwright against both the
  miniflare-served production build and the kit dev server); see its README
  for the covered kit surface (form actions, cookies, binary endpoints, route
  groups, prerender + SSR mix, `platform.env`/`platform.caches`).
