# @fixtures/waku-durable-objects

E2e fixture for `@distilled.cloud/waku` exercising a **framework site plus the
user's own Durable Objects on the same worker** — the pattern alchemy's
`Website.Vite` already supports via its custom `main` entry (see the
"Custom Worker Entry" section in
`packages/alchemy/src/Cloudflare/Website/Vite.ts`: point `main` at a module
that wraps the framework handler and re-exports DO classes), and which the
new waku framework package does **not** support yet.

The app is a waku site (a dynamic page + a `/counter` API route) whose
`src/worker-entry.ts` is the user's own worker entry: it wraps waku's emitted
fetch handler and exports `class Counter`, a SQLite-backed Durable Object.
`e2e.config.ts` declares the namespace (`durableObjectNamespaces` on the dev
worker config, `durableObjects` on the miniflare preview config) and binds it
with `DurableObjectNamespace.local({ binding: "COUNTER", className: "Counter" })`.

## Status: PENDING — gated until the waku custom-worker-entry seam lands

`@distilled.cloud/waku`'s cloudflare target unconditionally pins the bundler
entry to waku's own rsc server entry:

```ts
// packages/waku/src/cloudflare.ts — makeWakuPluginOptions
main: NodePath.join(inputs.wakuDirectory, WAKU_SERVER_ENTRY_PATH),
```

so the fixture's `target.cloudflare.worker.main` is silently discarded, the
`Counter` class never reaches the deployed module graph, and the `COUNTER`
namespace cannot resolve. The suite is written against the **intended**
behavior and cannot pass yet. To keep CI green, `bun run test` routes through
`scripts/e2e.mjs`, which prints

```
waku-durable-objects: pending the waku custom-worker-entry seam — see fixtures/waku-durable-objects/README.md
```

and exits 0 unless `WAKU_DO_ENABLE=1` is set. The enablement pass should run

```sh
WAKU_DO_ENABLE=1 bun run test
```

and, once green, remove the gate (make `test` call `playwright test`
directly, adding a `pretest` chromium install).

## Missing integration surface (what the seam must add)

1. **User `main` precedence in the waku cloudflare target** —
   `makeWakuPluginOptions` must honor `pluginOptions.main` (resolved against
   the project root) instead of always pinning waku's entry, exactly like
   `Website.Vite`'s "`main` takes precedence over any entry configured in the
   Vite config". The wrapped entry must be bundled in the **rsc** environment
   (waku's entry topology `{ entry: "rsc", children: ["ssr"] }` is unchanged).
2. **An importable specifier for waku's server handler** — the user entry
   needs to import the framework handler it wraps, but waku's real entry
   (`dist/lib/vite-entries/entry.server.js`) is not on waku's exports map.
   The target's vite plugins must resolve a stable id — this fixture assumes
   `virtual:waku/server-entry` (precedent: React Router's
   `virtual:react-router/server-build`) — to the resolved
   `<wakuDirectory>/dist/lib/vite-entries/entry.server.js`.
3. **Entry-module selection in the build output** — `serverModules[0]` is
   pinned to `WAKU_SERVER_ENTRY_MODULE` (`server/index.js`); with a wrapped
   entry the emitted chunk for the user's `main` must become the entry module
   instead.
4. **DeployTarget contract carriage** — the generic framework-core
   `DeployTarget` needs a documented place for "user worker entry that wraps
   the framework's emitted entry" so astro/sveltekit/etc. can implement the
   same seam; today each target invents its own `main` handling.
5. **Alchemy's `Website.Waku`** needs the `main`-equivalent prop that
   forwards to this seam (parity with `Website.Vite`'s `main`).

## What the app exercises (once enabled)

- SSR page (`/`) reading the Counter DO at request time (`data-testid=do-count`)
- `/counter` API route: `POST` increments, `GET` reads — asserted to
  increment **across requests**, proving DO instance identity on the same
  worker (live + dev)
- static asset (`/hello.txt`) still served alongside the custom entry
- the `MESSAGE` Text binding through the wrapped handler (framework routes
  unaffected by wrapping)

## Commands

```sh
bun run dev       # waku dev with the rsc environment in workerd (port 3110)
bun run build     # waku build -> dist/ + dist/build.json
bun run preview   # miniflare over dist/build.json
bun run test      # GATED: no-op unless WAKU_DO_ENABLE=1 (see above)
```
