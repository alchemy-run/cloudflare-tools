# @fixtures/sveltekit

E2E fixture for `@distilled.cloud/sveltekit` — a SvelteKit app built and served
without wrangler:

- **SSR** home page whose `+page.server.ts` load reads a `platform.env` value
  supplied by a `Text.local` binding (and checks `platform.ctx.waitUntil`).
- **Form actions** (`/form`): a named action (`?/greet`) exercised both via
  progressive enhancement (`use:enhance`, no full navigation) and as a plain
  no-JavaScript POST (HTML re-render; kit's CSRF origin check included).
- **Cookies** (`/cookies`): a `+page.server.ts` load that reads and re-sets a
  visit-counter cookie — `Set-Cookie` round-trips through the worker shim and
  kit's dev SSR alike.
- **Binary endpoint** (`/api/binary`): a 256-byte octet-stream response
  asserted byte-for-byte.
- **Route group** (`(marketing)/about`): group layout `+layout.server.ts`
  data rendered by the group layout, with the group segment absent from the
  URL (and the literal `/(marketing)/...` path a 404).
- **`platform.caches`** (`/api/cache`): a cache-aside endpoint over
  `caches.default` — a real cache hit in live mode, the documented no-op stub
  in dev (see below).
- **Server endpoint** `/api/hello` exercising `cookie` (v2), `uuid`
  (browser/node conditional exports), and `node:crypto` under `nodejs_compat`.
- **Prerendered** page (`/prerendered`) served from static assets, alongside
  SSR routes (prerendered + SSR mix).
- **Client-interactive** counter page (`/counter`) proving hydration.
- **Static asset** (`static/robots.txt`).

There is no `svelte.config.js`, `vite.config.ts`, or `wrangler.json` — the
SvelteKit config (including the deploy target's in-memory Cloudflare adapter)
is assembled programmatically by `@distilled.cloud/sveltekit` from
`e2e.config.ts`. The config uses the harness's target-scoped carriage
(`target.cloudflare.worker` for the worker config, `target.cloudflare.preview`
for the miniflare preview); the deploy target itself defaults to
`@distilled.cloud/sveltekit/cloudflare`.

## Commands

```sh
bun run build    # e2e build — kit build + in-memory adapt() + rolldown re-bundle -> dist/build.json
bun run preview  # e2e preview — miniflare over dist/build.json + .svelte-kit/cloudflare assets
bun run dev      # e2e dev --port 3103 — kit's own Vite dev server (Node SSR, stub platform)
bun run test     # playwright: the same suite against both `live` (miniflare) and `dev`
```

`bun run test` goes through `scripts/e2e.mjs`, which skips the suite on
Windows CI only (runner-level socket exhaustion outside this repo — see the
comment in that file).

## Modes

- **live** — the production path: `Framework.build` produces entry-first
  workerd-ready server modules (the Cloudflare target's rolldown finishing
  pass) and the `.svelte-kit/cloudflare` assets directory; the harness serves
  them with miniflare (assets binding `ASSETS`, worker invoked behind the
  assets router).
- **dev** — SvelteKit's own Vite dev server (Node SSR, full HMR). `platform`
  comes from the deploy target's stub emulator (see below).

Both modes run the same Playwright suite in `test/smoke.test.ts`, which shares
one worker-scoped server per mode (a single dev server / miniflare instance
for the whole file — do not add per-test servers).

## The dev stub-platform seam

Dev runs kit's Node SSR, so real Cloudflare bindings are not available. The
Cloudflare target's adapter `emulate()` returns a **stub platform**:

- `platform.env` — derived from the fixture's declared worker bindings: `Text`
  and `Json` bindings become plain values (`resolveDevEnvironment` in
  `@distilled.cloud/sveltekit`); resource bindings (KV, R2, D1, ...) are
  skipped.
- `platform.ctx` — no-op `waitUntil` / `passThroughOnException`.
- `platform.caches` — a **no-op cache wrapper**: `match` always misses, `put`
  and `delete` do nothing. Code written cache-aside (like `/api/cache`) works
  unchanged in dev, it just never hits. The suite asserts this asymmetry
  explicitly (`cached: true` on the second live request, `cached: false` in
  dev).
- `platform.cf` — `{}`.
- During prerendering, `platform.env` access **throws** (mirroring upstream):
  prerenderable routes must not depend on request-time bindings.

Real dev bindings arrive with the cloudflare-runtime Node-side bindings proxy
(the `getPlatformProxy` replacement); this stub is the documented interim.

## The caches wrapper (live)

In live mode the worker entry is the generated shim from
`@distilled.cloud/sveltekit/cloudflare`, which replaces the upstream adapter's
`worktop/cfw.cache` dependency with an inline pragma-cache over
`caches.default`: GET/HEAD responses carrying a `cache-control` header are
cached and served from cache unless the request says `no-cache`;
`Set-Cookie` responses are marked `private=Set-Cookie`. Handlers also receive
the real Cache API via `platform.caches` (what `/api/cache` uses). Endpoint
responses without `cache-control` (e.g. kit's `json(...)`) are untouched by
the pragma-cache.
