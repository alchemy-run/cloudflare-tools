# @fixtures/waku

E2E fixture for `@distilled.cloud/waku` — the wrangler-free [Waku](https://waku.gg)
integration for Cloudflare Workers.

There is no `waku.config.ts`, no `vite.config.ts`, and no `wrangler.jsonc`:
`e2e.config.ts` selects the framework and carries the entire worker
configuration in memory (compatibility date/flags, bindings, assets behavior).

## What it exercises

- **SSR / RSC** — `src/pages/index.tsx` is a dynamic page rendered by the
  worker at request time, reading the `MESSAGE` text binding through
  `cloudflare:workers` (workerd module-runner in dev, miniflare in preview).
- **SSG** — `src/pages/about.tsx` is a static page prerendered at build time
  into `dist/public` (HTML + RSC payload), exercising waku's
  `__WAKU_START_PREVIEW_SERVER__` build path.
- **Client interactivity** — `src/components/Counter.tsx` is a
  `"use client"` component hydrated in the browser.
- **Static assets** — `public/hello.txt` rides along in `dist/public`.

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
shown in `src/pages/index.tsx` (the same trick waku's own adapter uses).
