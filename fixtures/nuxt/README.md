# fixtures/nuxt

E2E fixture for `@distilled.cloud/nuxt`: a Nuxt 4 app built programmatically
through the project's `@nuxt/kit` with nitro's `cloudflare_module` preset —
wrangler-free (no `wrangler.json` is read or written).

What it exercises:

- **Native `nuxt.config.ts` loading** — `runtimeConfig.public.fixtureMarker`
  and the `routeRules["/prerendered"].prerender` rule are user settings the
  suite observes.
- **SSR + runtime contract** — the home page reads
  `event.context.cloudflare.env.FIXTURE_SECRET` during SSR; `/api/hello`
  checks `context.waitUntil`.
- **Prerendering** — `/prerendered` is written into `.output/public` at build
  time and served by the assets layer.
- **Client hydration** — `/counter` flips a `data-hydrated` marker from
  `onMounted` before interaction.
- **The nitro entry/exports seam** — `worker-entry.ts` is the configured
  `main`: nitro bundles it as the worker entry, so its exports (nitro's
  wrapped handler + the `Counter` SQLite Durable Object) are the worker's
  exports; `/api/counter` drives the DO through the `COUNTER` namespace
  binding.

Modes: the **live** suite (miniflare over `dist/build.json`) always runs. The
**dev** suite is written but pending until the Nuxt dev transport lands
(`NUXT_DEV_ENABLE=1` opts in; see `scripts/e2e.mjs`).

Dev port: 3111.
