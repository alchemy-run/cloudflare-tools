# @fixtures/sveltekit

E2E fixture for `@distilled.cloud/sveltekit` — a SvelteKit app built and served
without wrangler:

- **SSR** home page whose `+page.server.ts` load reads a `platform.env` value
  supplied by a `Text.local` binding (and checks `platform.ctx.waitUntil`).
- **Server endpoint** `/api/hello` exercising `cookie` (v2), `uuid`
  (browser/node conditional exports), and `node:crypto` under `nodejs_compat`.
- **Prerendered** page (`/prerendered`) served from static assets.
- **Client-interactive** counter page (`/counter`) proving hydration.
- **Static asset** (`static/robots.txt`).

There is no `svelte.config.js`, `vite.config.ts`, or `wrangler.json` — the
SvelteKit config (including the wrangler-free in-memory Cloudflare adapter) is
assembled programmatically by `@distilled.cloud/sveltekit` from
`e2e.config.ts`.

## Commands

```sh
bun run build    # e2e build — kit build + in-memory adapt() + rolldown re-bundle -> dist/build.json
bun run preview  # e2e preview — miniflare over dist/build.json + .svelte-kit/cloudflare assets
bun run dev      # e2e dev --port 3103 — kit's own Vite dev server (Node SSR, stub platform)
bun run test     # playwright: the same suite against both `live` (miniflare) and `dev`
```

## Modes

- **live** — the production path: `Framework.build` produces entry-first
  workerd-ready server modules (rolldown +
  `@distilled.cloud/cloudflare-rolldown-plugin`) and the
  `.svelte-kit/cloudflare` assets directory; the harness serves them with
  miniflare (assets binding `ASSETS`, worker invoked behind the assets router).
- **dev** — SvelteKit's own Vite dev server (Node SSR, full HMR). `platform`
  is the documented phase-1 stub: `env` derives from the fixture's `Text`
  bindings, `ctx.waitUntil` is a no-op. Real dev bindings arrive with the
  cloudflare-runtime Node-side bindings proxy.
