# @distilled.cloud/waku

Wrangler-free [Waku](https://waku.gg) integration for Cloudflare Workers.
Implements `@distilled.cloud/framework-core`'s `Framework` service —
programmatic `build` / `dev` / `readBuildOutput` over
`@distilled.cloud/cloudflare-vite-plugin` — with **no wrangler dependency and
no wrangler.json/toml read or written**.

## How it works

- **Config, in memory.** `make(options)` builds waku's `Config` via
  `unstable_resolveConfig`: `unstable_adapter` is pinned to this package's
  wrangler-free fork of waku's cloudflare adapter (`./adapter`), the cloudflare
  vite plugin is injected _inside_ `config.vite.plugins` (the position upstream
  documents for `@cloudflare/vite-plugin`, and the only one where the workerd
  proxy middleware registers ahead of waku's Node request bridge), and the
  rsc/ssr environments get the documented `optimizeDeps` includes plus
  `platform: "neutral"`.
- **`build`** replicates waku's `runBuild`: `vite.createBuilder` +
  `unstable_combinedPlugins`, with `globalThis.__WAKU_START_PREVIEW_SERVER__`
  set so the SSG step works. The `BuildOutput` is collected with a
  post-`buildApp` disk re-read (waku writes `__waku_build_metadata.js` and
  prunes static-only chunks after the bundler finishes) and persisted to
  `dist/build.json`.
- **`dev`** replicates waku's `runDev` with the cloudflare plugin injected, so
  the rsc environment runs in workerd with in-memory bindings and HMR.
- **`./adapter`** is a ~200-line fork of `waku/adapters/cloudflare` (built
  entirely on public `waku/adapter-builders` + `waku/internals` exports) whose
  single functional change is `buildEnhancers: []` — dropping
  `waku/adapters/cloudflare-build-enhancer`, the sole wrangler-file writer in
  waku.

## Usage (e2e harness)

```ts
// e2e.config.ts
import * as Options from "@distilled.cloud/e2e/Options";

export default Options.make({
  framework: "@distilled.cloud/waku",
  vite: {
    compatibilityDate: "2026-03-10",
    compatibilityFlags: ["nodejs_als"],
    worker: { name: "my-waku-app", bindings: [] },
  },
  miniflare: {
    /* preview-only options */
  },
});
```

Or the typed form for waku-specific options:

```ts
import wakuFramework from "@distilled.cloud/waku";

framework: (options) => wakuFramework({ ...options, port: 3101, waku: { srcDir: "app" } }),
```

## Known limitation

SSG renders in **Node** (waku's adapter fallback middleware — upstream parity
with running `waku build` without `@cloudflare/vite-plugin`), so a top-level
`import { env } from "cloudflare:workers"` in any page module breaks the
build. Use a guarded dynamic import instead. Workerd-backed SSG preview is the
planned parity enhancement.

## Version pinning

Everything this package touches in waku is `unstable_`-prefixed and waku is in
beta — `waku` is pinned exactly (`1.0.0-beta.7`); treat version bumps as
deliberate migrations.
