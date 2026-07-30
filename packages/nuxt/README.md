# @distilled.cloud/nuxt

Nuxt integration implementing framework-core's `Framework` service, with the
deploy target passed as a value (Cloudflare Workers by default) — wrangler-free.

- **`build`** drives the PROJECT's `@nuxt/kit` programmatically:
  `loadNuxt({ cwd, dev: false, ready: false, overrides })` — the project's own
  `nuxt.config.ts` loads natively — with hooks registered before
  `nuxt.ready()`, then `buildNuxt`. The deploy target's nitro preset
  (`cloudflare_module`) gets the last word via the `nitro:config` hook; a
  user-configured foreign `nitro.preset` fails with an actionable error. The
  resulting `.output` is already self-contained workerd ESM, so the
  `BuildOutput` is read straight from disk: `serverModules` entry-first from
  `.output/server`, `clientDirectory` = `.output/public` (prerendered pages
  included), no finishing pass.
- **`dev`** is not implemented yet — it fails with a descriptive
  `FrameworkError` until the dev-transport phase lands (Nuxt SSR in a Node
  worker thread with `event.context.cloudflare` served wrangler-free).

Subpaths:

- `@distilled.cloud/nuxt/cloudflare` — the Cloudflare Workers `NuxtTarget`:
  nitro preset selection, `cloudflare.deployConfig: false` (never writes a
  `wrangler.json`), `cloudflare.nodeCompat: true` by default, and the
  user-entry seam (a configured `main` becomes nitro's `entry`, so the user
  module's exports — nitro's wrapped handler plus Durable Object classes —
  are the worker's exports; wrap
  `nitropack/presets/cloudflare/runtime/cloudflare-module`).
- `@distilled.cloud/nuxt/source` — alchemy `WorkerSourceModule` (structural
  contract mirror; `dev()` not implemented yet).

Versions: upstream surfaces are pinned — nuxt `4.5.x`, nitropack `2.13.x`
(see `fixtures/nuxt`); treat version bumps as deliberate migrations.
