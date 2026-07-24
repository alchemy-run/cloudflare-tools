# @fixtures/vocs

E2E fixture for [vocs](https://vocs.dev) (the minimal React documentation
framework) on Cloudflare Workers.

Vocs 2.x is built on **waku**: its `vocs()` vite plugin (public export
`vocs/vite`) composes waku's own `waku/vite-plugins` (environments,
adapter-alias, static-build, ...) with vocs's mdx/config/patch plugins, and it
peer-depends on `waku ^1.0.0-beta.6`. It is *not* a fully static site: page
bodies are prerendered RSC elements, but the document shell is SSR'd per
request and there are dynamic API routes (`/api/search`, `/api/og`,
`/api/mcp`, `/api/feedback`) — so it runs as a worker.

Vocs does not use waku's `unstable_combinedPlugins`, so the
`@distilled.cloud/waku` Framework layer can't drive it directly. Instead,
`framework.ts` is a fixture-local `Framework` implementation that mirrors
`packages/waku`'s orchestration with vocs's plugin stack swapped in, reusing
the deploy-target halves from `@distilled.cloud/waku/cloudflare` (the
wrangler-free adapter fork, selected through vocs's `unstable_adapter`
passthrough, + the cloudflare vite plugin pinned to waku's rsc entry).

There is no `vite.config.ts` and no `wrangler.jsonc`: `e2e.config.ts` carries
the entire worker configuration in memory; `vocs.config.ts` is vocs's own
(platform-agnostic) docs config.

## What it exercises

- **Worker SSR** — the docs shell (sidebar, layout) is rendered by the worker
  at request time in both dev (workerd module-runner) and preview (miniflare).
- **MDX pages** — `src/pages/*.mdx` with sidebar navigation.
- **Client interactivity** — `src/components/Counter.tsx` is a
  `"use client"` component embedded in MDX, hydrated in the browser.
- **Static assets** — `public/hello.txt` rides along in `dist/public`, next to
  vocs's build-time artifacts (`llms.txt`, `llms-full.txt`).

## Commands

```sh
bun run dev      # vocs dev over workerd (port 3105)
bun run build    # programmatic vocs build -> dist/ + dist/build.json
bun run preview  # miniflare over dist/build.json
bun run test     # playwright: live (built worker) + dev
```
