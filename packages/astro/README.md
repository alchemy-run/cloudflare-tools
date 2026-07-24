# @distilled.cloud/astro

Programmatic, wrangler-free Astro integration.

This package implements framework-core's `Framework` service for Astro —
effectful `build`/`dev` over Astro's public programmatic API (`import { build,
dev } from "astro"`) with a fully in-memory `AstroInlineConfig` (no
`astro.config.*`) — and takes the **deploy target as a value**. The Cloudflare
Workers target (a fork of `@astrojs/cloudflare` over
`@distilled.cloud/cloudflare-vite-plugin`, with no wrangler dependency and no
`wrangler.json` anywhere) ships at the `./cloudflare` subpath.

```ts
import * as Astro from "@distilled.cloud/astro";
import cloudflare from "@distilled.cloud/astro/cloudflare";

const layer = Astro.make({
  target: cloudflare({
    worker: {
      compatibilityDate: "2026-03-10",
      compatibilityFlags: ["nodejs_compat"],
      worker: {
        name: "my-app",
        bindings: [
          /* in-memory bindings */
        ],
      },
    },
  }),
  astro: { site: "https://example.com" },
});
// layer: Layer<Framework> — Framework.build → BuildOutput, Framework.dev → { url }
```

## Architecture: framework half × deploy-target half

The package separates two concerns (see `packages/framework-core/README.md`,
"Architecture: frameworks × deploy targets", for the full doctrine):

| Half                             | Modules                                                                                                                                                          | Contents                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Framework (platform-neutral)** | `src/index.ts`, `src/Astro.ts`, `src/Target.ts`, `src/environments.ts`                                                                                           | The `Framework` service implementation: inline-config synthesis (`makeAstroInlineConfig`), programmatic `build()`/`dev()` driving, the shared build-output collector (`entryEnvironment: "ssr"`, `skipEnvironments: ["astro", "prerender"]`), deploy-target resolution. **Zero Cloudflare imports** — enforced by `test/decoupling.test.ts`. |
| **Cloudflare target**            | `src/cloudflare.ts` (subpath `@distilled.cloud/astro/cloudflare`), `src/integration.ts`, `src/config-plugin.ts`, `src/prerender-middleware.ts`, `src/runtime/**` | The `AstroTarget` factory plus everything Cloudflare: the forked `@astrojs/cloudflare` integration over our vite plugin, the vendored runtime entrypoints, the `virtual:astro-cloudflare:config` plugin, the dev node-prerender middleware plugin.                                                                                           |
| **alchemy source provider**      | `src/source.ts` (subpath `@distilled.cloud/astro/source`)                                                                                                        | The alchemy `Cloudflare.Workers` source module (structural `SourceProvider` mirror): `build`/`hash`/`dev` for the alchemy Worker resource. Cloudflare-specific by definition; constructs the Cloudflare target directly.                                                                                                                     |

A future platform (e.g. AWS) is a new subpath implementing the same
`AstroTarget` seams — no change to the framework half or to framework-core.

### The `AstroTarget` contract

`AstroTarget` extends framework-core's generic `DeployTarget` with one
framework-specific hook:

```ts
interface AstroTarget<Config = unknown> extends DeployTarget<Config> {
  /** The Astro adapter integration pinned into AstroInlineConfig.adapter. */
  readonly integration: () => AstroIntegration;
}
```

Everything platform-specific rides inside that integration (Astro's adapter
API is already the right seam: it injects vite plugins, selects the server
entrypoint, and configures the build). The generic `DeployTarget` seams are
honored by the framework half:

- `target.build` — **wholesale build takeover**: when defined, `Framework.build`
  delegates the entire production build to the target. (The Cloudflare Astro
  target does not define it — Astro drives its own build.)
- `finish` — a post-build finishing pass, applied via
  `applyDeployTargetFinish` after the collector produces the `BuildOutput`
  (the Astro build is delivered in-memory, so the finish context carries no
  on-disk `entry`).
- `bundle` — resolve/bundle metadata (`conditions`, `external`); informational
  for Astro since the integration configures the bundler itself.
- `serve` — local serving of _built_ output; the e2e harness's Cloudflare
  target provides this (miniflare). Not the HMR dev path.

### How the target is passed

`Astro.make({ target, targetConfig })` accepts a `DeployTargetInput`:

- an `AstroTarget` **value** — used as-is (full type safety; build it yourself
  by importing the target module),
- a **factory** `(config) => AstroTarget` — applied to `targetConfig`,
- a **module specifier** string — loaded from the _project's_ `node_modules`
  (its `default` — or named `target` — export is the value or factory),
  applied to `targetConfig`.

Omitting `target` defaults to `"@distilled.cloud/astro/cloudflare"`, so
existing Cloudflare users need no change. The target is resolved once per
`build`/`dev` operation; a resolved target missing the `integration` hook
fails with a typed `FrameworkError`.

## Options

### `Astro.make(options?: AstroFrameworkOptions)`

| Option         | Type                | Description                                                                                                                                                                                                                  |
| -------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`       | `AstroTargetInput`  | Deploy target (value / factory / specifier). Default: `"@distilled.cloud/astro/cloudflare"`.                                                                                                                                 |
| `targetConfig` | `unknown`           | Config handed to a target factory / specifier-loaded module. Opaque to the framework half. Unused when `target` is a value.                                                                                                  |
| `astro`        | `AstroInlineConfig` | Extra Astro config merged into the in-memory inline config (`site`, `base`, `redirects`, `integrations`, `devToolbar`, `vite`, ...). `root`, `configFile: false`, and `adapter` are pinned; `output` defaults to `"server"`. |
| `root`         | `string`            | Project root. Defaults to `process.cwd()`.                                                                                                                                                                                   |

### Cloudflare target config (`cloudflare(config)`)

| Option                 | Type                          | Description                                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker`               | `CloudflareVitePluginOptions` | Compatibility date/flags, worker name/bindings/assets behavior, runtime context — everything a `wrangler.json` would have carried, in-memory. `main`, `viteEnvironments`, and Astro's node environments in `skipEnvironments` are managed by the integration. |
| `sessionKVBindingName` | `string`                      | KV binding name injected into Astro's session config when present on the Worker env. Default `"SESSION"`.                                                                                                                                                     |

### E2e-harness usage

The default export is the harness framework factory. It reads the harness's
cloudflare worker options structurally
(`options.target?.cloudflare?.worker ?? options.vite`) and forwards them as
the default target's config:

```ts
// e2e.config.ts — untyped carriage
export default Options.make({
  target: { cloudflare: { worker: { /* ... */ }, preview: { /* miniflare */ } } },
  framework: "@distilled.cloud/astro",
});

// e2e.config.ts — typed target value (recommended; see fixtures/astro)
framework: (options) =>
  Astro.make({
    target: cloudflare({ worker: Options.resolveCloudflareOptions(options).worker }),
    astro: { devToolbar: { enabled: false } },
  }),
```

## What the Cloudflare target does

The integration is a fork of `@astrojs/cloudflare` v14.1.3 (which upstream
builds on `@cloudflare/vite-plugin` + a wrangler peer dependency), reworked to
be wrangler-free over `@distilled.cloud/cloudflare-vite-plugin`:

- **Swapped plugin.** `@cloudflare/vite-plugin` → our plugin, `main` pinned to
  the vendored server entrypoint (`@distilled.cloud/astro/entrypoints/server`),
  worker environment `ssr`, Astro's node-side `astro`/`prerender` environments
  in `skipEnvironments`. Dev SSR executes inside workerd via the vite module
  runner with in-memory bindings; the dev `env.ASSETS` 404/asset fallback is
  satisfied by the runtime's vite-aware assets loopback (`Assets.local`).
- **Dropped.** `loadWranglerEnv` + `.dev.vars`, wrangler-config file watchers,
  the `previewEntrypoint` (our runtime serves the build output), the
  output-`wrangler.json` patch, and the workerd prerenderer.
- **Hardwired.** `prerenderEnvironment: "node"` (Astro's stock node
  prerenderer + the dev node-prerender middleware plugin) and the
  `passthrough` image service (see limitations).
- **Kept (vendored).** The runtime entrypoints/handler/helpers (verified free
  of wrangler/`@cloudflare/vite-plugin` imports — enforced by the "vendored
  runtime purity" test), the `virtual:astro-cloudflare:config` plugin (not
  exported upstream), the `optimizeDeps.include` environment plugin, the
  `cf-imports`/`cf-externals` plugins, and the `astro:build:setup` server
  tweaks (`ssr.noExternal`, `sharp` external, process-env banner).
- **Typegen guard.** `build`/`sync` run Astro's type generation, which boots a
  temporary vite server; the integration strips `configureServer` from the
  cloudflare plugins in those phases (mirroring upstream) so workerd never
  boots mid-build — our dev environments degrade to runnable stubs, a
  supported contract of the dev plugin.

### Build output

`Framework.build` returns the `BuildOutput` contract in-memory:
`serverModules` (entry first — the `ssr` entry chunk `server/entry.mjs`,
re-read from disk because Astro injects the serialized SSR manifest after the
bundler finishes) and `clientDirectory` (`dist/client`, captured as a path so
prerendered HTML written after the vite build rides along). No
`wrangler.json`, no `.wrangler/` directory, anywhere.

## Limitations

- **Node prerendering.** Prerendered routes (`export const prerender = true`)
  execute in Astro's stock **node** prerender environment, not workerd
  (upstream's `prerenderEnvironment: "node"` mode). Pages that import
  `cloudflare:workers` (or otherwise rely on worker-only APIs) at prerender
  time will fail to prerender. A workerd prerender loop over
  cloudflare-runtime is possible later (the upstream HTTP protocol is small);
  until then this is an accepted fidelity gap.
- **Image service is passthrough.** workerd cannot run sharp, and the `IMAGES`
  binding is remote-only in our runtime, so the integration hardwires Astro's
  `passthrough` image service: images are served as-is (no resizing /
  format negotiation). The production endpoint is the vendored
  `image-passthrough-endpoint`; dev uses Astro's generic node endpoint.
- **Sessions.** Astro's default KV-backed session driver is left unconfigured
  (our runtime has no local KV emulation yet). When a KV binding named
  `sessionKVBindingName` exists on the worker env it is injected into the
  session config; otherwise sessions are off.
- **`astro preview` is not used.** The upstream preview entrypoint hard-depends
  on a wrangler deploy config; serving built output is the deploy target's
  `serve` concern (miniflare in the e2e harness; the alchemy dev loop uses
  cloudflare-runtime).
- **Version pinning.** Astro's JS API is `@experimental`, and the integration
  internals (virtual module names, adapter features) are versioned with Astro
  majors. The fork tracks `astro` 7.x / adapter v14.1.3; treat version bumps
  as deliberate migrations backed by the fixture e2e suite.

## Testing

- `bun run test` — unit tests (`test/Astro.test.ts`: target module, config
  synthesis, integration hooks, wholesale-build delegation;
  `test/decoupling.test.ts`: the framework half's cloudflare-free guarantee
  and runtime purity).
- `fixtures/astro` — the playwright e2e suite driving a real app through the
  harness in both `dev` (workerd module runner) and `live` (miniflare over the
  built output) modes: SSR + bindings, middleware locals/headers, config
  redirects, JSON/binary endpoints, content collections, prerendered pages,
  public assets, ASSETS 404 fallback.
