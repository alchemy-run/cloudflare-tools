# Build Manifest Architecture

The distilled Cloudflare Vite plugin is Wrangler-free. A production build must
therefore emit enough information for a deploy consumer, such as Alchemy's
`Cloudflare.Vite`, to upload the already-built Worker modules and static assets
without reverse engineering Vite output directories.

The build manifest is written as `__distilled-build.json` in the build output
root. All paths in the manifest are POSIX paths relative to that manifest file.

## Manifest Shape

```ts
type BuildManifest = {
  version: 2;
  workers: {
    app: {
      main: string;
      modules: Array<{
        path: string;
        type: "esm" | "wasm" | "data" | "text" | "json";
      }>;
      compatibilityDate?: string;
      compatibilityFlags?: Array<string>;
    };
  };
  assets?: {
    directory: string;
    htmlHandling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
    notFoundHandling?: "none" | "404-page" | "single-page-application";
    runWorkerFirst?: boolean | Array<string>;
  };
};
```

`version` is required so deploy consumers can reject unknown contract versions.

`workers.app` is the only Worker key emitted today. Additional `workers.*` keys
are reserved for future multiple-Worker support, but this contract does not
currently imply that deployers should expect or synthesize extra Workers.

`assets.directory`, when present, points to the static asset output directory
relative to the manifest root. It is derived from Vite's client build output and
is not user-configurable in Vite mode.

`assets.htmlHandling`, `assets.notFoundHandling`, and `assets.runWorkerFirst`
mirror the Vite plugin's asset routing options. They are emitted only when the
application configures them, so deployers can preserve dev/build routing
semantics without guessing.

## Worker Modules

`workers.app.main` is the entry module to upload as the Worker entrypoint.

`workers.app.modules` is the complete module set for that Worker. Entries are
sorted by `path`, unique, and typed explicitly so deployers do not need to infer
Cloudflare module kind from file extension.

Module types map as follows:

| Manifest type | Source files                        | Cloudflare module kind |
| ------------- | ----------------------------------- | ---------------------- |
| `esm`         | `.js`, `.mjs`                       | ES module              |
| `wasm`        | `.wasm`, `.wasm?module` emissions   | Wasm module            |
| `data`        | `.bin`                              | Data module            |
| `text`        | `.txt`, `.html`, `.sql`             | Text module            |
| `json`        | `.json`, except Vite build metadata | JSON module            |

Source maps are not Worker modules. If deploy consumers need source-map upload
metadata later, that should be a separate manifest field rather than mixed into
`workers.app.modules`.

## RSC Topology

React Server Components can produce several Vite environment outputs for one
deployed Worker. In the React Router / `@vitejs/plugin-rsc` topology used by
this plugin, the Worker runs in the `rsc` environment and loads the `ssr`
environment at runtime through `import.meta.viteRsc.loadModule("ssr", ...)`.

The `ssr` output is not a separate service Worker in this topology. It is a
second module graph whose generated files are imported by the `rsc` Worker
module graph. The manifest therefore folds the entry environment output and all
configured child environment outputs into one `workers.app.modules` set.

This preserves the relative import layout emitted by the framework. Deployers
should upload the folded module set as one Worker, not rewrite the child output
into a service binding.

## Compatibility Metadata

`compatibilityDate` and `compatibilityFlags` record what the Worker was compiled
against. When present, deployers must deploy with the same values.

`compatibilityDate` is optional because the plugin option is optional. Absence is
still authoritative: a deployer should fail or require an explicit deploy-time
value rather than silently substituting a default and claiming it matches the
build.

## Vite Configuration Defaults

The Vite plugin owns the Vite asset output path, so static apps can use
`cloudflare()` with no options and Worker apps do not specify an asset
directory. Asset routing options live at the top level:

```ts
cloudflare({
  main: "./worker/index.ts",
  assets: {
    notFoundHandling: "single-page-application",
  },
});
```

The legacy `worker.assets` location is still accepted for advanced runtime
configuration. If the same routing option is provided in both places with
different values, the plugin throws instead of choosing one silently.

The plugin intentionally does not infer `main` or default the production
`compatibilityDate`. Those values define Worker architecture and runtime
semantics, so a deployer should either read the explicit build metadata or ask
for a deploy-time value.

## Emission Rules

A successful Worker build emits a fresh manifest. Before writing, the plugin
removes any stale manifest at the target path.

If a build has no Worker entry, such as a pure SPA or assets-only build, the
plugin emits no manifest and removes any stale manifest.

Worker environment output directories are emptied before the build writes. This
keeps stale files from prior builds out of `workers.app.modules`, including in
frameworks that perform scan passes before final write passes.

Every Worker module path must stay inside the manifest root. If entry and child
environment outputs split across incompatible roots, the plugin skips manifest
emission and warns rather than writing a graph whose generated relative imports
cannot resolve.

## Future: Multiple Workers

Alchemy can model multiple Cloudflare Workers and native service bindings. That
is the right abstraction for real Worker-to-Worker relationships.

The manifest shape is intentionally compatible with future multiple-Worker
support by nesting Worker descriptions under `workers`. A future API could look
like this:

```ts
cloudflare({
  workers: {
    app: {
      main: "./app/entry.worker.ts",
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    },
    api: {
      main: "./api/worker.ts",
    },
  },
});
```

That future API should add explicit deployment units to the manifest, for
example `workers.api`. It should not infer service Workers from
`viteEnvironment.childEnvironments`; a Vite child environment is a module graph
loaded by another environment unless a framework/runtime protocol says
otherwise.
