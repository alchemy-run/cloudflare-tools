# `@distilled.cloud/cloudflare-vite-plugin`

Vite plugin for running Cloudflare Workers with the distilled runtime.

## Usage

Static Vite apps can use the plugin with no options:

```ts
import cloudflare from "@distilled.cloud/cloudflare-vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare()],
});
```

For an app with a Worker entry and SPA asset fallback:

```ts
import cloudflare from "@distilled.cloud/cloudflare-vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({
      main: "./worker/index.ts",
      compatibilityDate: "2026-03-10",
      assets: {
        notFoundHandling: "single-page-application",
      },
    }),
  ],
});
```

The plugin derives the asset directory from Vite's client build output. Do not
configure an asset directory in Vite mode.

## Options

- `main?: string` - Worker entry module. Static/assets-only apps omit this.
- `compatibilityDate?: string` - Worker compatibility date. Keep this explicit
  for production builds so deploys match the build.
- `compatibilityFlags?: Array<string>` - Worker compatibility flags.
- `viteEnvironment?: { name?: string; childEnvironments?: Array<string> }` -
  Worker Vite environment topology, including RSC child environments.
- `assets?: { htmlHandling?, notFoundHandling?, runWorkerFirst? }` - routing
  options for Vite-managed assets. Assets are served before the Worker unless
  `runWorkerFirst` opts into Worker-first routing.
- `worker?: { name?, bindings?, durableObjectNamespaces?, hyperdrives?, assets? }`
  - advanced local runtime options.
- `context?: Context.Context<RuntimeServices>` - custom runtime service context.

`worker.assets` remains supported for advanced runtime configuration, but the
top-level `assets` option is preferred for Vite asset routing. If the same
asset routing option is set in both places with different values, the plugin
throws.

## Build Manifest

Worker builds write `__distilled-build.json` beside the build output. The
manifest records the Worker entry module, every Worker module that must be
uploaded, compatibility metadata, and the Vite client asset directory. Asset
routing options from `assets` are copied into the manifest so deploy consumers
can preserve the same routing behavior.

Pure static/assets-only builds do not emit a Worker manifest.
