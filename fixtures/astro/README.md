# @fixtures/astro

E2e fixture for `@distilled.cloud/astro` — a wrangler-free Astro app on
Cloudflare Workers, driven entirely through the e2e harness's `Framework`
service (no `astro.config.*`, no `wrangler.json`).

The app exercises:

- an on-demand SSR page (`/`) reading a `Text.local` binding via
  `cloudflare:workers`, with a client-interactive counter script
- a prerendered page (`/about/`) served from assets in production and by
  Astro's node prerender middleware in dev
- an API route (`/api/hello`) reading the binding + asserting the `ASSETS`
  binding exists
- a `public/` static asset (`/robots.txt`)
- the 404 fallback path through `env.ASSETS.fetch`

## Commands

```sh
bun run dev       # astro dev with the ssr environment in workerd (port 3102)
bun run build     # astro build -> dist/ + dist/build.json
bun run preview   # miniflare over dist/build.json
bun run test      # playwright: live (miniflare) + dev projects
```
