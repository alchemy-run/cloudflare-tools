# @fixtures/astro-ssr

E2e fixture for `@distilled.cloud/astro` exercising the **SSR-first path with
an honored user config file**. Where `fixtures/astro` is mostly prerendered
and fully programmatic (no `astro.config.*`), this fixture is the inverse: a
**real `astro.config.mjs`** (`output: "server"`, redirects,
`security.checkOrigin: false`, dev toolbar off) that the integration must load
and respect per the user-config principle, driving an app where every route is
on-demand unless it opts into prerendering.

## Status: PENDING — gated until the user-config wave lands

The current integration pins `configFile: false` (the fixture's
`astro.config.mjs` is ignored), so this suite is written against the
**intended** behavior and cannot pass yet. To keep CI green, `bun run test`
routes through `scripts/e2e.mjs`, which prints

```
astro-ssr: pending the user-config wave — see fixtures/astro-ssr/README.md
```

and exits 0 unless `ASTRO_SSR_ENABLE=1` is set. The enablement pass (after
the "respect user config files" wave refactors `packages/astro`) should run

```sh
ASTRO_SSR_ENABLE=1 bun run test
```

and, once green, remove the gate (make `test` call `playwright test`
directly, restoring the `pretest` chromium install).

## What the app exercises

- dynamic param routes (`/greet/[name]`) rendered per request — no
  `getStaticPaths`, any param resolves
- per-request middleware (`src/middleware.ts`): fresh `requestId` in
  `Astro.locals` (rendered by every SSR page) mirrored onto `x-request-id` /
  `x-middleware` response headers
- a server-handled form POST (`/feedback`): GET renders the form, POST reads
  `formData()` and re-renders with the echoed message; direct `fetch` POSTs
  rely on the user config's `security.checkOrigin: false`
- an `Astro.session` round-trip (`/session`) via zero-config sessions (KV
  driver, `SESSION` binding auto-provisioned in dev / miniflare KV in live)
- a streaming-friendly page (`/stream`): early chunk flushed before an async
  component boundary resolves
- JSON (`/api/hello`, GET + POST echo) and binary (`/api/binary`) endpoints
- ONE prerendered page (`/about/`, `export const prerender = true`) as the
  hybrid exception — served from assets in production
- a redirect declared in `astro.config.mjs` (`/legacy-greeting` →
  `/greet/astro`) whose target is on-demand, so it must be handled by the
  worker in both dev and live
- a `public/` static asset (`/robots.txt`) and the 404 path for unmatched
  routes

## Commands

```sh
bun run dev       # astro dev with the ssr environment in workerd (port 3106)
bun run build     # astro build -> dist/ + dist/build.json
bun run preview   # miniflare over dist/build.json
bun run test      # GATED: no-op unless ASTRO_SSR_ENABLE=1 (see above)
```
