# Spike: Astro dev-mode ASSETS binding + programmatic build with forked integration

**Verdict: PROVED (with caveats that are package-side fixes, not blockers to the approach).**

Both legs of the spike work end-to-end:

1. **Programmatic build** — astro's public `build(AstroInlineConfig)` with `configFile: false`
   and an in-memory fork of `@astrojs/cloudflare` that swaps `@cloudflare/vite-plugin` for
   `@distilled.cloud/cloudflare-vite-plugin` (`main: '@astrojs/cloudflare/entrypoints/server'`,
   entry env `ssr`) emits `dist/server/entry.mjs` + chunks and `dist/client/` (prerendered HTML +
   public assets) with **no wrangler.json anywhere**, and the output boots and serves correctly
   in miniflare.
2. **THE RISK (dev)** — astro `dev()` with our plugin/runtime on the `ssr` env works. The CF
   handler's unconditional `env.ASSETS.fetch` on 404/asset fallback **is satisfied by our
   `ViteAssets` loopback** — `Assets.local("ASSETS")` in `worker.bindings` binds the vite-aware
   `assets:worker` service, and the 404 path round-trips through the html-exists/fetch-html
   Loopback handlers without a shim. Middleware ordering does not break page serving, the node
   prerender middleware, public-dir assets, or `/@vite/client`.

**Recommendation: the package should take the our-vite-plugin-inside-astro path** (PLAN §2.2 as
written). The fallback (unmodified-minus-wrangler fork emitting via `@cloudflare/vite-plugin`) is
unnecessary.

## Fixture

`fixtures/spike-astro/` — workspace member; `astro@7.1.0` + `@astrojs/cloudflare@14.1.3`
(exact pins — see "minimumReleaseAge" below).

| File | Role |
| --- | --- |
| `integration.ts` | The fork: ~250 lines, mostly deletions from upstream `packages/integrations/cloudflare/src/index.ts` plus three SPIKE WORKAROUND plugins (see findings) |
| `scripts/config.ts` | Shared `AstroInlineConfig` (fully in-memory; `Assets.local("ASSETS")` + `Text.local("SPIKE_VALUE")` bindings) |
| `scripts/dev-test.ts` | `dev()` + 7 HTTP assertions |
| `scripts/build.ts` | `build()` + dist-layout assertions |
| `scripts/preview-test.ts` | miniflare boot of `dist/server` modules + `dist/client` assets, 5 assertions |
| `src/pages/{index,about}.astro`, `src/pages/api/hello.ts`, `public/robots.txt` | one on-demand SSR page, one `prerender = true` page, one API route reading `env` via `cloudflare:workers`, one public asset |

## Exact commands + results

```sh
cd fixtures/spike-astro
bun scripts/dev-test.ts       # 7/7 PASS
bun scripts/build.ts          # build layout OK (no wrangler.json anywhere)
bun scripts/preview-test.ts   # 5/5 PASS (miniflare)
```

Dev assertions (all PASS): on-demand SSR page inside workerd; `/api/hello` returns the
`Text.local` binding value AND `typeof env.ASSETS.fetch === "function"`; `/definitely-not-a-route`
→ astro's 404 page with status 404 (exercises `fallbackToAssets` → `env.ASSETS.fetch` →
assets:worker → Vite loopback → miss → handler renders 404); `/about/` served by astro's node
prerender middleware; `/robots.txt` via vite publicDir middleware; `/@vite/client` 200 (our
catch-all post-middleware does not shadow vite internals).

Build emits (20 files): `server/entry.mjs` (worker entry — astro's `entryFileNames` names it
`build.serverEntry` because the facade is the env's rolldown input), `server/virtual_astro_middleware.mjs`,
`server/chunks/*.mjs` (17), `client/about/index.html`, `client/robots.txt`. The `.prerender/`
build dir is cleaned up by astro. Zero wrangler.json, zero `.wrangler/`.

Preview assertions (all PASS): SSR page, binding read, prerendered HTML from assets
(`invoke_user_worker_ahead_of_assets: false`), 404 via ASSETS fallback, static asset.

## What broke and why (the real findings)

Three genuine incompatibilities surfaced, all worked around **from the integration fork** in the
fixture (no `packages/*` edits). Each is a small package-side fix:

### 1. Our plugins are not environment-scoped; astro adds NODE server environments

Astro's dev server has four environments: `client`, `ssr` (ours/workerd), and two **node-side**
ones — `astro` (tooling helper) and `prerender` (created by the node-prerender plugin). First run
died in `nodejsUnenvPlugin`'s `configureServer`:

```
error: Vite Internal Error: registerMissingImport is not supported in dev prerender
    at registerMissingImport (vite/dist/node/chunks/node.js:33899)
    at packages/cloudflare-rolldown-plugin/dist/plugins/nodejs-compat.js:163
    at async configureServer (nodejs-compat.js:154)
```

Two distinct problems:

- `nodejs-compat`'s `configureServer` iterates **every** `server.environments` and calls
  `depsOptimizer.registerMissingImport(...)`; environments using vite's no-discovery
  ("explicit") optimizer throw on that method by design.
- More generally, our per-environment hooks (unenv resolveId, worker resolve conditions,
  optimizeDeps) must not apply to node-side environments at all.

Workarounds in the fork: (a) set `applyToEnvironment` on every returned plugin to exclude
`prerender`/`astro` (this gates resolveId/load/transform/configEnvironment but NOT server-level
hooks); (b) a `enforce: "pre"` guard plugin, ordered before ours, that wraps
`registerMissingImport` on the node environments' optimizers in a try/catch (`configureServer`
hooks of `enforce: "pre"` plugins run before all normal ones — the nodejs-compat plugins are
`enforce: "pre"`, so the guard must be too).

### 2. `optionsPlugin` clobbers the framework's `builder.buildApp`

First build attempt died with:

```
error: rolldownOptions.input should not be an html file when building for SSR.
    at packages/cloudflare-rolldown-plugin/dist/plugins/options.js:179   <- OUR default buildApp
    at buildApp (vite) <- astro's buildEnvironments called builder.buildApp()
```

Vite merges plugin `config` results **over** the user config (`conf = mergeConfig(conf, res)` in
`runConfigHook`), so the default `builder.buildApp` our optionsPlugin returns unconditionally
replaced **astro's own buildApp orchestrator** (prerender → ssr → client with dynamic client-input
discovery and chunk extraction). Our naive "build every environment" loop then tried to build the
node `astro` env, which has no input. The fixture works around it with a pre-plugin that captures
`config.builder?.buildApp` and a post-plugin that restores it.

### 3. `cloudflareVitePlugin()` returns a sparse array

The returned `PluginOption[]` contains a falsy entry (fine for vite, but anything iterating the
array to post-process plugins must filter). Cosmetic.

### Also needed (mirrored from upstream, not a bug): strip `configureServer` during build/sync

`build`/`sync` run astro's type-gen, which creates a temporary vite server and fires
`configureServer` — without stripping it (exactly as upstream does for `@cloudflare/vite-plugin`,
astro #16332) our dev plugin would boot workerd mid-build. The fork strips `configureServer` off
our plugin instances when `command === 'build' || command === 'sync'`; our
`dev.createEnvironment` already degrades to a runnable env when `configureServer` is absent, so
this composes cleanly.

## What worked as designed (no changes needed)

- **`env.ASSETS` in dev**: `Assets.local("ASSETS")` + `ViteAssetsLive` satisfies the fetcher
  contract of `utils/cf-helpers.ts` (`matchStaticAsset`, `fallbackToAssets`,
  `createErrorPageFetch`). No dev shim required. This was the spike's #1 unknown.
- **`main: '@astrojs/cloudflare/entrypoints/server'`** as a bare specifier: `resolveInputPath`
  passes non-path specifiers through, the worker-entry virtual wrapper re-exports it, and the ssr
  env resolves it with workerd conditions. Entry chunk lands as `entry.mjs`.
- **Astro steps around the non-runnable ssr env**: `DistilledDevEnvironment` is not runnable, so
  astro core skips its node SSR handler; our catch-all post-middleware forwards page requests to
  workerd; astro's node prerender middleware (enabled via the tiny
  `createNodePrerenderPlugin` copy + `prerenderEnvironment: 'node'` path) registers ahead of our
  catch-all and intercepts prerendered routes.
- **`virtual:astro-cloudflare:config`**: the ~40-line `createConfigPlugin` copied verbatim (it is
  NOT exported from the published package — the fork must vendor it).
- **Upstream's `optimizeDeps.include` list** for `astro`/`ssr`/`prerender` envs works under our
  optimizer (minus prism/content-runtime entries the fixture doesn't need).
- **Runtime entry purity**: `@astrojs/cloudflare/dist/entrypoints/server.js` +
  `dist/utils/handler.js` import zero wrangler code. No `wrangler` package was installed at any
  node_modules path (bun did not materialize the peer); `@cloudflare/vite-plugin` (a regular dep
  of `@astrojs/cloudflare`) lands in the bun store (~9 MB) but is never imported — the real
  package may want to vendor the ~5 runtime files to shed it entirely.
- **Sessions/images**: sessions left unconfigured (no KV needed; `injectSessionBinding` no-ops),
  `imageService: passthrough` equivalent hardwired. Matches PLAN §2.2 defaults
  (`compile`/passthrough until local KV + Images emulation land).

## Environment note

The repo's `bunfig.toml` `minimumReleaseAge = 259200` blocked `astro@7.1.2` (published < 3 days
ago, same-day as the submodule pin) — the fixture pins `astro@7.1.0` + `@astrojs/cloudflare@14.1.3`
exactly. Same policy briefly blocked the whole workspace install via a sibling spike fixture's
deps (shared lockfile); expect this any time a spike pins a fresh upstream release.

## Implications for `@distilled.cloud/astro` (package design)

1. **Take the vite-plugin path** (PLAN §2.2). The fork shape validated here is the package shape:
   swap the CF plugin, keep the runtime entrypoints, vendor `createConfigPlugin` + the
   node-prerender plugin + the environment/optimizeDeps/cf-externals plugins, drop wrangler env
   loading/watchers/preview/workerd-prerenderer.
2. **cloudflare-vite-plugin / rolldown-plugin need first-class environment scoping** before the
   real package lands (blockers below): a `skipEnvironments` (or "node environments") option that
   (a) sets `applyToEnvironment` on all our per-env plugins and (b) makes `nodejs-compat`'s
   `configureServer` skip environments whose optimizer doesn't support `registerMissingImport`
   (or simply skip non-worker envs).
3. **`optionsPlugin` must not override a user-provided `builder.buildApp`** — only default it when
   `userConfig.builder?.buildApp` is absent. One-line fix; without it every buildApp-owning
   framework (astro today, others tomorrow) breaks.
4. The Effect `Framework` service wrapper is now mechanical: `build()` = astro `build(inline)` +
   the shared collector injected via `AstroInlineConfig.vite.plugins` with
   `entryEnvironment: 'ssr'`, `skipEnvironments: ['prerender']` (the prerender env builds to
   `dist/server/.prerender/` and is deleted post-generation — it must not leak into
   `serverModules`); `dev()` = `acquireRelease(dev(inline), s => s.stop())`, URL from
   `server.address`/`resolvedUrls`. `serverModules[0]` = `entry.mjs`; `clientDirectory` =
   `dist/client` captured as a path so post-vite prerendered HTML rides along.
5. Alchemy `Website.Astro` passes resolved bindings through the fork's plugin options —
   dev-with-real-bindings falls out of `worker.bindings` exactly as it did for
   `Text.local`/`Assets.local` here.
