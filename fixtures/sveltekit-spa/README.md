# @fixtures/sveltekit-spa

E2E fixture for `@distilled.cloud/sveltekit` exercising the **pure-SPA path**:
`ssr = false` in the root `+layout.ts`, the adapter's SPA fallback page, and —
the nuance under test — `+server.ts` endpoints that **still run server-side**
even though every page is client-rendered.

Where `fixtures/sveltekit` is SSR-first, this fixture is the inverse:

- `src/routes/+layout.ts` sets `ssr = false` / `prerender = false` for the
  whole app.
- `notFoundHandling: "single-page-application"` in `e2e.config.ts` drives the
  in-memory adapter's fallback generation (`builder.generateFallback` →
  `index.html`) and must flow through to the deployed assets'
  `not_found_handling` (mirrored in the miniflare preview's `assetConfig`).
- A **real user `vite.config.ts`** registers `sveltekit()` with a user alias
  (`$spa` → `src/lib`) the widgets page imports through and a user
  `preprocess` that rewrites a marker rendered by the home page — the file
  must be loaded natively per the user-config principle. There is
  deliberately NO `svelte.config.js`: kit v3 (`3.0.0-next.9`) hard-errors on
  its presence ("svelte.config.js is no longer used") — ALL configuration,
  including Svelte `preprocess`/`compilerOptions`, lives in the
  `sveltekit(...)` call.

## Status: PENDING — gated until the user-config wave lands

This suite is written against the **intended** behavior of the "respect user
config files" wave (plus the SPA fallback / `not_found_handling` wiring
through our adapter) and cannot pass until that wave lands. To keep CI green,
`bun run test` routes through `scripts/e2e.mjs`, which prints

```
sveltekit-spa: pending the user-config wave — see fixtures/sveltekit-spa/README.md
```

and exits 0 unless `SVELTEKIT_SPA_ENABLE=1` is set. The enablement pass should
run

```sh
SVELTEKIT_SPA_ENABLE=1 bun run test
```

and, once green, remove the gate (make `test` call `playwright test`
directly, restoring a `pretest` chromium install).

## What the app exercises

- **Client-side routing** between three routes (`/`, `/widgets`, `/about`)
  with a planted `window` marker proving no full navigation occurs.
- **Deep links**: a direct request for `/widgets` returns the app shell (no
  widget markup in the raw HTML — asserted via the `sveltekit-spa-shell`
  marker in `app.html`) and hydrates into the correct view, in both live and
  dev.
- **Universal load, server endpoint** (`/widgets` + `/api/widgets`): the
  `+page.ts` load runs exclusively in the browser (`ssr = false`), while the
  `+server.ts` endpoint it fetches runs server-side and reads a
  `Text.local` binding (`FIXTURE_MESSAGE`) from `platform.env`.
- **SPA fallback / not_found_handling**: an unmatched path
  (`/definitely/not/a/route`) serves the shell and hydrates into kit's
  client-side 404 error view (`+error.svelte`).
- **Direct static asset** serve (`static/robots.txt`).
- **User config honored**: the `$spa` kit alias and the marker preprocessor
  (both declared in the user's `vite.config.ts` `sveltekit(...)` call) are
  observable in the rendered app.

## Commands

```sh
bun run dev       # kit's Vite dev server via the harness (port 3108)
bun run build     # kit build + in-memory adapt() + rolldown pass -> dist/build.json
bun run preview   # miniflare over dist/build.json + .svelte-kit/cloudflare assets
bun run test      # GATED: no-op unless SVELTEKIT_SPA_ENABLE=1 (see above)
```
