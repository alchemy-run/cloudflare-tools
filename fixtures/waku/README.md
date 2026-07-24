# @fixtures/waku

E2E fixture for `@distilled.cloud/waku` — the wrangler-free [Waku](https://waku.gg)
integration for Cloudflare Workers.

There is no `waku.config.ts`, no `vite.config.ts`, and no `wrangler.jsonc`:
`e2e.config.ts` selects the framework and carries the entire worker
configuration in memory via the target-scoped carriage
(`target.cloudflare.worker` for the dev/build worker config,
`target.cloudflare.preview` for the miniflare preview server).

## What it exercises

- **SSR / RSC** — `src/pages/index.tsx` is a dynamic page rendered by the
  worker at request time, reading the `MESSAGE` text binding through
  `cloudflare:workers` (workerd module-runner in dev, miniflare in preview).
- **Server actions** — `src/actions.ts` is a `"use server"` module driven by
  `useActionState` in `src/components/GreetingForm.tsx`: the form submission
  round-trips through the RSC endpoint and executes inside the worker (the
  action reads the `MESSAGE` binding to prove it).
- **Dynamic route params** — `src/pages/items/[id].tsx` receives the `[id]`
  segment as a prop and renders at request time.
- **API routes** — `src/pages/_api/echo.ts` exports `GET`/`POST` handlers,
  served at `/echo` (waku strips the `_api` prefix).
- **SSG** — `src/pages/about.tsx` is a static page prerendered at build time
  into `dist/public` (HTML + RSC payload), exercising waku's
  `__WAKU_START_PREVIEW_SERVER__` build path.
- **Client interactivity** — `src/components/Counter.tsx` is a
  `"use client"` component hydrated in the browser.
- **Client state across navigation** — `src/components/NavCounter.tsx` lives
  in the (static) layout; its state must survive waku's client navigation
  because the router keeps the layout mounted while swapping pages.
- **Static assets** — `public/hello.txt` rides along in `dist/public`.

Every behavior is asserted in both Playwright modes (`live` = built worker
under miniflare, `dev` = workerd-backed vite dev server) from one shared
worker-scoped server fixture per mode — no per-test servers.

## Commands

```sh
bun run dev      # waku dev over workerd (port 3101)
bun run build    # programmatic waku build -> dist/ + dist/build.json
bun run preview  # miniflare over dist/build.json
bun run test     # playwright: live (built worker) + dev
```

## Known limitation (upstream parity)

SSG rendering happens in **Node** (waku's adapter fallback path), so a page
with a _top-level_ `import { env } from "cloudflare:workers"` breaks the
build — waku imports every page module in Node during SSG to read
`getConfig`, even for dynamic pages. Use the guarded dynamic-import pattern
in `src/env.ts` (the same trick waku's own adapter uses).
