# Spike: SvelteKit adapter output re-bundled for workerd

**Verdict: PROVED (with caveats).** A minimal SvelteKit app builds via programmatic Vite with a
~120-line in-memory adapter (no wrangler.json, no vite.config.ts, no svelte.config.js), the
node22-flavored `_worker.js` output re-bundles for workerd with rolldown +
`@distilled.cloud/cloudflare-rolldown-plugin` **using only the plugin's defaults** (no aliases, no
extra conditions), and the result boots in `@distilled.cloud/cloudflare-runtime` with all 9
assertions passing: SSR 200, endpoint 200, prerendered page served, client asset served, and
`platform.env` reading a real `Text.local` binding.

Fixture: `fixtures/spike-sveltekit/` (scripts: `bun run build && bun run bundle && bun run boot`).

## What was built

- **App** (`src/routes/`): SSR home page whose `+page.server.ts` load reads
  `platform.env.SPIKE_SECRET` + `platform.ctx.waitUntil` and uses `devalue`; a server endpoint
  `/api/hello` using `cookie` (v2, ESM), `uuid` (browser/node conditional exports), and
  `node:crypto.randomUUID` directly; a `/prerendered` page with `export const prerender = true`.
- **`scripts/adapter.ts`** — the in-memory kit `Adapter`, a wrangler-free fork of
  `@sveltejs/adapter-cloudflare`'s `adapt()`: `builder.writeClient` + `builder.writePrerendered`
  into `.svelte-kit/cloudflare`, `builder.generateManifest` → `cloudflare-tmp/manifest.js`, a
  generated worker shim (`_worker.js`) with **real relative import paths templated directly**
  (upstream's prebuilt-`files/worker.js` + SERVER/MANIFEST string-replacement step is unnecessary
  when the shim is generated in-memory), `.assetsignore`. Always Workers mode; no
  `unstable_readConfig`, no Pages branch, no `_routes.json`, no `emulate()`.
  `worktop/cfw.cache` was **dropped from the shim** (the pragma-cache is skipped; see caveats).
- **`scripts/build.ts`** — `await sveltekit({ adapter })` → `vite.createBuilder({ root,
  configFile: false, plugins }, null)` → `builder.buildApp()`. Exactly the `Vite.ts` shape.
- **`scripts/bundle.ts`** — `rolldown({ input: ".svelte-kit/cloudflare/_worker.js", plugins:
  cloudflare({ compatibilityDate, compatibilityFlags: ["nodejs_compat"], exports: ["default"] }) })`
  → `dist/worker/index.js` + 11 chunks (~380 KB total). This replaces `wrangler deploy`'s bundling.
- **`scripts/boot.ts`** — reads `dist/worker/**` entry-first, `Runtime.start({...,
  bindings: [Text.local("SPIKE_SECRET", ...), AssetsBinding.local("ASSETS")], assets: { directory:
  ".svelte-kit/cloudflare", runWorkerFirst: false } })`, then asserts over plain `fetch`.

## Exact commands

```sh
cd fixtures/spike-sveltekit
bun scripts/build.ts    # kit build + in-memory adapt() — also works under node v26
bun scripts/bundle.ts   # rolldown re-bundle for workerd
bun scripts/boot.ts     # cloudflare-runtime boot + 9 assertions (exit 0)
```

## Results

```
PASS ssr-status          GET / -> 200
PASS ssr-platform-env    rendered: secret:s3cret-from-binding   (real Text.local binding, not a stub)
PASS ssr-ctx             ctx:yes                                 (platform.ctx.waitUntil is a function)
PASS ssr-devalue         devalued:{n:1}
PASS endpoint-status     GET /api/hello -> 200
PASS endpoint-body       {"uuid":"…","nodeUuid":"…","cookie":"spike=ok","secret":"s3cret-from-binding"}
PASS prerendered-status  GET /prerendered -> 200
PASS prerendered-content contains this-page-is-prerendered
PASS client-asset        GET /_app/immutable/nodes/1.uwwL3pOc.js -> 200
```

### The risk (R3, node22 output → workerd conditions): resolved with plugin defaults

The re-bundled output's only remaining externals are `cloudflare:workers` and `node:crypto`
(legitimate under `nodejs_compat`). Dependency resolution under the plugin's default conditions
(`workerd, worker, module, browser, production`):

- `uuid` (dual browser/node exports) → **browser entry** (`crypto.getRandomValues`) — works in workerd.
- `cookie` v2, `devalue` — plain ESM, inlined cleanly.
- kit's own server graph (`.svelte-kit/output/server/**`, built with `target: 'node22'`) — inlined
  with zero condition conflicts; kit pre-inlines `esm-env` precisely so downstream bundlers don't
  mis-resolve it, and that held.
- No aliases, no unenv overrides, no `platform` tweaks were needed — `cloudflare({ ... })` with
  compat flags was the entire config.

## What broke along the way (all root-caused)

1. **`bun install` blocked by `minimumReleaseAge`** (root `bunfig.toml`, 3 days):
   `@sveltejs/kit@3.0.0-next.11` (published 2026-07-20) and `devalue@5.8.2` were rejected.
   → pinned **kit `3.0.0-next.9`** (2026-07-17, just clears the gate) and `devalue@5.8.1`. The
   submodule analysis targets next.11; every API used here (`sveltekit(config)`, `Adapter`,
   `Builder.writeClient/writePrerendered/generateManifest/getBuildDirectory/rimraf/mkdirp`,
   `buildApp`) is identical in next.9.
2. **`cookie` v2 renamed its API** — my fixture used v1's `serialize`; v2 exports
   `stringifySetCookie`. App bug, not an integration bug. (The kit build error surfaced in kit's
   `analyse` postbuild worker importing the server chunk — both bun and node reported it the same
   way.)
3. **`boot.ts` never exits after success** — after the Effect scope closes (workerd killed), the
   runtime's exit hooks / loopback server keep the event loop alive. Fine for a long-running dev
   server; one-shot scripts need an explicit `process.exit`. Worth knowing for the `Framework`
   service's `build`-then-verify flows and tests.
4. **First `bun install` spinlock attempt left a stale `/tmp/ct-bun-lock`** (macOS has no
   `timeout(1)`, and `status` is a read-only zsh variable) — operational note only.

## Caveats (deliberately out of spike scope)

- **Pragma cache dropped**: the shim omits upstream's `worktop/cfw.cache` lookup/save. The real
  package should replace it with a ~30-line `caches.default` wrapper (plan §2.3 already says so);
  resolving `worktop` itself through the rolldown pass was not tested.
- **`_headers`/`_redirects`/`404.html` generation** not ported (no user files and no prerendered
  redirects in the fixture). Straight fork-copy from upstream; no risk signal.
- **Dev/`emulate()`** untouched (phase-1 stub / phase-2 bindings proxy per plan).
- **kit is pre-release** (`3.0.0-next.x`): the in-memory `sveltekit(config)` + `Adapter` surface is
  new in v3 and may still shift (plan's R1 stands). `builder.instrument` / service workers untested.
- Prerendered pages were served by the **assets router** (`runWorkerFirst: false` — Workers-mode
  default) before the worker's own `prerendered.has(pathname)` branch could run; both paths exist,
  only the router path is asserted.

## Implications for `@distilled.cloud/sveltekit`

1. **The design in research/sveltekit.md §C is validated as-is.** Keep `sveltekit()` untouched,
   supply our own in-memory adapter, run the rolldown pass as a separate step after `buildApp()`
   (adapter records paths; service bundles — the spike's `result.current` handoff maps to that).
2. **Generate the shim, don't prebuild it.** Templating `_worker.js` with real import paths
   removes upstream's publish-time rolldown prebuild + `builder.copy` string replacement (R6
   disappears entirely).
3. **The rolldown pass needs no special configuration** — `cloudflare({ compatibilityDate,
   compatibilityFlags, exports: ["default"] })` on the `_worker.js` input is sufficient; emit
   entry-first chunks and feed them to `readServerModulesFromDisk` (framework-core helper, still
   needed — the spike hand-rolled it).
4. **cloudflare-runtime gap: no public credentials-free layer.** `RuntimeServices.layerRuntime`
   requires `Credentials` + an `accountId` even for purely local workers; the spike set dummy
   `CLOUDFLARE_API_TOKEN`/account values. The credentials-free composition exists only as a test
   helper (`test/helpers/runtime.ts#localRuntimeLayer`) and can't be rebuilt by consumers because
   `internal/Paths` isn't exported. The runtime should export a `layerLocalRuntime()` (or make
   remote bindings lazy) before framework packages ship preview/serve commands.
5. **`Assets.local("ASSETS")` + `assets.directory` fully satisfies the kit shim** — including
   `server.init({ read })`'s `ASSETS.fetch`, `.assetsignore` handling, and direct serving of
   prerendered HTML with `htmlHandling: "auto-trailing-slash"`. No dev shim fetcher needed for
   the built path.
6. **Version pinning must account for the repo's `minimumReleaseAge`** (3 days): pinning the
   package to the newest kit `next.N` the day it ships will break `bun install` here.
