# @fixtures/astro

E2e fixture for `@distilled.cloud/astro` — a wrangler-free Astro app on
Cloudflare Workers, driven entirely through the e2e harness's `Framework`
service (no `astro.config.*`, no `wrangler.json`).

`e2e.config.ts` uses the target-scoped config carriage (`target.cloudflare`)
and passes the Cloudflare deploy target as a typed _value_
(`cloudflare({ worker })` from `@distilled.cloud/astro/cloudflare`) to
`Astro.make`.

The app exercises:

- an on-demand SSR page (`/`) reading a `Text.local` binding via
  `cloudflare:workers`, with a client-interactive counter script
- middleware (`src/middleware.ts`): writes `Astro.locals` (rendered by
  `/locals`) and mutates response headers (`x-middleware`) on on-demand routes
- a `redirects` config entry (`/old-about` → `/about/`), handled dynamically
  by the worker (the integration sets `build: { redirects: false }`)
- a prerendered page (`/about/`) served from assets in production and by
  Astro's node prerender middleware in dev
- a content-collection-driven static page (`/posts/hello-world/`): glob
  loader over `src/posts/*.md`, `getStaticPaths` + `render` from
  `astro:content`, prerendered at build time
- API routes returning JSON (`/api/hello`, reads the binding + asserts the
  `ASSETS` binding exists) and binary data (`/api/binary`,
  `application/octet-stream`)
- a `public/` static asset (`/robots.txt`)
- the 404 fallback path through `env.ASSETS.fetch`

Known limitations (see the package README for details): prerendering runs in
**node**, not workerd, so prerendered pages must not import
`cloudflare:workers` at render time; the image service is **passthrough**
(no sharp in workerd); middleware header mutations are only observable on
on-demand routes (prerendered pages are static files in production).

## Commands

```sh
bun run dev       # astro dev with the ssr environment in workerd (port 3102)
bun run build     # astro build -> dist/ + dist/build.json
bun run preview   # miniflare over dist/build.json
bun run test      # playwright: live (miniflare) + dev projects
```
