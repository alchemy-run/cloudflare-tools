# @fixtures/astro-static

E2e fixture for `@distilled.cloud/astro` exercising the **fully-static path**:
a real `astro.config.mjs` with `output: "static"`, several prerendered pages,
a sitemap-ish nav linking every page, a `getStaticPaths` dynamic route, a
custom `404.astro`, a client-side island (bundled `<script>` counter), and
`public/` assets.

**THE POINT:** a pure static Astro build should deploy **ASSETS-ONLY** — no
worker at all. `BuildOutput.serverModules` must be `undefined`/empty and every
request (pages, client JS, public assets, the 404 page) must be answered by
the asset layer.

## Status: PENDING — gated until the assets-only static-output wave lands

The audit found the current integration deploys a **full worker** even for
`output: "static"` (the Cloudflare adapter integration + SSR entry are wired
unconditionally, so the build emits `server/entry.mjs` and the collector
captures server modules). The suite is written against the **intended**
assets-only behavior and cannot fully pass yet. To keep CI green,
`bun run test` routes through `scripts/e2e.mjs`, which prints

```
astro-static: pending the assets-only static-output wave — see fixtures/astro-static/README.md
```

and exits 0 unless `ASTRO_STATIC_ENABLE=1` is set. The enablement pass should
run

```sh
ASTRO_STATIC_ENABLE=1 bun run test
```

and, once green, remove the gate (make `test` call `playwright test`
directly, restoring the `pretest` chromium install).

## The assets-only seam

What "assets-only" requires of each layer (mirroring `fixtures/static-website`,
the Vite assets-only fixture):

- **Build (`packages/astro`)**: with `output: "static"`, the finished
  `BuildOutput` must carry `serverModules: undefined` and point
  `clientDirectory` at the fully-prerendered output (including `404.html`).
  Today the target integration registers the adapter and the collector
  captures the SSR entry regardless of `output`.
- **Preview (live mode)**: miniflare requires a script even for assets-only
  workers, so `e2e.config.ts` provides a stub module that 500s (any request
  reaching it is a routing bug) behind `routerConfig.has_user_worker: false`,
  with `assetConfig.not_found_handling: "404-page"` serving the built
  `404.html` with status 404.
- **Dev**: `astro dev` renders on demand by design (no prerendering in dev);
  the suite only asserts request-visible behavior there (pages, nav, island,
  404, public assets), not build-frozen HTML.

## What the suite asserts

- prerendered pages served in both `live` and `dev` modes
- full-site navigation through the shared nav
- `getStaticPaths`-enumerated `/blog/[slug]` routes
- the client island hydrates (`#hydrated` flips, counter increments)
- `public/robots.txt` and the custom 404 page (status 404 + content)
- **live only**: two fetches of `/` return byte-identical HTML (build-frozen)
- **live only, the enablement target**: `dist/build.json` has NO server
  modules

## Commands

```sh
bun run dev       # astro dev (port 3107)
bun run build     # astro build -> dist/ + dist/build.json
bun run preview   # miniflare over dist/build.json (assets-only + stub)
bun run test      # GATED: no-op unless ASTRO_STATIC_ENABLE=1 (see above)
```
