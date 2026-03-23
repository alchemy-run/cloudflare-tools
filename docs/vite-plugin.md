# @cloudflare/vite-plugin Bundling Pipeline — Full Audit

> Source: `workers-sdk/packages/vite-plugin-cloudflare/src/`

This document catalogs the bundling-relevant pieces of the Cloudflare Vite plugin. Dev server, preview, HMR, and Miniflare integration are noted but not deeply explored — the focus is on **what happens during a production build** that transforms user code into a deployable Worker bundle.

---

## Table of Contents

1. [Pipeline Overview](#1-pipeline-overview)
2. [Plugin Architecture](#2-plugin-architecture)
3. [Environment Configuration](#3-environment-configuration)
4. [Entry Point Resolution & Virtual Modules](#4-entry-point-resolution--virtual-modules)
5. [Additional Modules (WASM, Data, Text)](#5-additional-modules-wasm-data-text)
6. [WASM Init Helper](#6-wasm-init-helper)
7. [Node.js Compatibility](#7-nodejs-compatibility)
8. [Node.js Compat Warnings](#8-nodejs-compat-warnings)
9. [Node.js ALS Support](#9-nodejs-als-support)
10. [Build Orchestration](#10-build-orchestration)
11. [Output Configuration](#11-output-configuration)
12. [Source Map Handling](#12-source-map-handling)
13. [Key Data Structures](#13-key-data-structures)
14. [Comparison with Wrangler](#14-comparison-with-wrangler)
15. [Porting Considerations](#15-porting-considerations)

---

## 1. Pipeline Overview

The Vite plugin delegates all bundling to Vite (Rollup or Rolldown). Its job is to configure Vite's build correctly for Cloudflare Workers, handle Workers-specific module types, and emit deployment configuration. The high-level flow for a production build:

```
Plugin Config Resolution
    ↓
Vite Environment Setup (one per Worker)
    ↓
Virtual Entry Module Generation:
  - Node.js global polyfill imports (if nodejs_compat)
  - Re-export user entry
    ↓
Vite/Rollup Build (per environment, parallel):
  - resolveId hooks: Node.js compat aliases, additional modules, cloudflare: builtins
  - load hooks: virtual modules (worker entry, export types, Node.js globals)
  - renderChunk hooks: replace additional module references with emitted asset paths
    ↓
Output Config Generation:
  - Emit wrangler.json with no_bundle: true (already bundled by Vite)
  - Move imported assets from worker output to client output
    ↓
Deploy Config Writing
```

---

## 2. Plugin Architecture

The `cloudflare()` function returns an array of **15 plugins** (13 in the array plus the wrapper). Only a subset are relevant to bundling:

| Plugin | Bundling Role |
|--------|---------------|
| `vite-plugin-cloudflare` (wrapper) | Sets `CLOUDFLARE_VITE_BUILD` env var |
| `configPlugin` | Creates Vite environment configs, watches config files |
| `virtualModulesPlugin` | Provides virtual worker entry, export types, Node.js global inject modules |
| `additionalModulesPlugin` | Handles `.wasm`, `.bin`, `.txt`, `.html`, `.sql` imports |
| `wasmHelperPlugin` | Provides `.wasm?init` deferred instantiation |
| `nodeJsCompatPlugin` | Resolves Node.js imports to `unenv` polyfills |
| `nodeJsAlsPlugin` | Marks `async_hooks` as builtin |
| `nodeJsCompatWarningsPlugin` | Warns when Node.js imports are used without `nodejs_compat` |
| `outputConfigPlugin` | Emits `wrangler.json` and `.dev.vars` |

The remaining plugins (`devPlugin`, `previewPlugin`, `shortcutsPlugin`, `debugPlugin`, `triggerHandlersPlugin`, `rscPlugin`, `virtualClientFallbackPlugin`) are dev/preview/framework-specific and not relevant to production bundling.

---

## 3. Environment Configuration

**File:** `cloudflare-environment.ts`

Each Worker gets its own Vite **Environment** with isolated build settings. The `createCloudflareEnvironmentOptions()` function generates the config:

### Build Settings

```ts
{
  build: {
    target: "es2024",
    emitAssets: true,
    manifest: isEntryWorker,       // .vite/manifest.json for asset tracking
    outDir: getOutputDirectory(userConfig, environmentName),
    copyPublicDir: false,
    ssr: true,
    // Rollup:
    rollupOptions: {
      input: { index: "virtual:cloudflare/worker-entry" },
      preserveEntrySignatures: "strict",
    },
    // OR Rolldown:
    rolldownOptions: {
      input: { index: "virtual:cloudflare/worker-entry" },
      preserveEntrySignatures: "strict",
      platform: "neutral",
      resolve: { extensions: [...] },
    },
  },
}
```

### Resolution Settings

```ts
{
  resolve: {
    noExternal: true,              // Bundle everything (no externals by default)
    conditions: ["workerd", "worker", "module", "browser", "development|production"],
    builtins: [
      "cloudflare:email",
      "cloudflare:node",
      "cloudflare:sockets",
      "cloudflare:workers",
      "cloudflare:workflows",
    ],
  },
}
```

### Defines

```ts
// Always:
"process.env.NODE_ENV": JSON.stringify(nodeEnv),
"global.process.env.NODE_ENV": JSON.stringify(nodeEnv),
"globalThis.process.env.NODE_ENV": JSON.stringify(nodeEnv),

// Without nodejs_compat:
"process.env": "{}",
"global.process.env": "{}",
"globalThis.process.env": "{}",
```

### Dependency Optimization (Dev)

```ts
{
  optimizeDeps: {
    noDiscovery: false,           // Enable SSR pre-bundling
    entries: workerConfig.main,   // Crawl from worker entry
    exclude: [
      ...cloudflareBuiltInModules,
      ...nonPrefixedNodeModules,
      ...nonPrefixedNodeModules.map(m => `node:${m}`),
      "node:sea", "node:sqlite", "node:test", "node:test/reporters",
    ],
  },
}
```

---

## 4. Entry Point Resolution & Virtual Modules

**File:** `plugins/virtual-modules.ts`

### Resolution Chain

1. User specifies `main` in their `wrangler.json` (or plugin config)
2. The build input is set to `virtual:cloudflare/worker-entry`
3. The `virtualModulesPlugin` resolves `virtual:cloudflare/user-entry` → the user's actual `main` file
4. The `virtual:cloudflare/worker-entry` module is generated dynamically:

```ts
// Generated content of virtual:cloudflare/worker-entry:
${nodeJsCompat ? nodeJsCompat.injectGlobalCode() : ""}
import { getExportTypes } from "virtual:cloudflare/export-types";
import * as mod from "virtual:cloudflare/user-entry";
export * from "virtual:cloudflare/user-entry";
export default mod.default ?? {};
if (import.meta.hot) {
  import.meta.hot.accept((module) => {
    const exportTypes = getExportTypes(module);
    import.meta.hot.send("vite-plugin-cloudflare:worker-export-types", exportTypes);
  });
}
```

### What this achieves:
- **Node.js global injection** happens before any user code via `injectGlobalCode()`
- **All user exports are preserved** (via `export *` and `export default`)
- **`preserveEntrySignatures: "strict"`** ensures Rollup doesn't add/remove exports
- **Export type detection** (HMR-only) — classifies exports as WorkerEntrypoint, DurableObject, or WorkflowEntrypoint

### Node.js Global Injection Code

When `nodejs_compat` is enabled, `injectGlobalCode()` generates:

```ts
import "virtual:cloudflare/nodejs-global-inject/unenv/runtime/node/buffer";
import "virtual:cloudflare/nodejs-global-inject/unenv/runtime/node/process";
// ... etc for each global
import "@cloudflare/unenv-preset/polyfill/...";  // side-effect polyfills
```

Each `virtual:cloudflare/nodejs-global-inject/*` module is resolved by the same plugin and generates:

```ts
import { Buffer as bufferExport } from "unenv/runtime/node/buffer";
globalThis.Buffer = bufferExport;
```

---

## 5. Additional Modules (WASM, Data, Text)

**File:** `plugins/additional-modules.ts`

This plugin handles non-JS module imports — the Vite equivalent of Wrangler's Module Collector.

### Default Rules

```ts
const moduleRules = [
  { type: "CompiledWasm", pattern: /\.wasm(\?module)?$/ },
  { type: "Data",         pattern: /\.bin$/ },
  { type: "Text",         pattern: /\.(txt|html|sql)$/ },
];
```

### Mechanism

**Phase 1 — `resolveId` (enforce: "pre"):**

When an import matches a module rule pattern:
1. Resolves the clean URL (strips `?module` query) to get the absolute file path
2. Marks it as **external** with a special encoded ID:
   ```
   __CLOUDFLARE_MODULE__CompiledWasm__/absolute/path/to/file.wasm__CLOUDFLARE_MODULE__
   ```
3. Tracks the path for hot-update restarts (dev only)

**Phase 2 — `renderChunk`:**

After Rollup generates chunks, this hook scans the output code for `__CLOUDFLARE_MODULE__` references:
1. Reads the original file from disk
2. Emits it as a Rollup asset via `this.emitFile()`
3. Replaces the encoded reference with a relative import path to the emitted asset
4. Generates a source map for the replacement (via MagicString) if sourcemaps are enabled

### Why This Two-Phase Approach?

The Vite plugin can't use Rollup's standard asset emission during `resolveId` because the chunk layout isn't known yet. By deferring to `renderChunk`, it can compute correct relative paths from the chunk's location to the emitted asset.

---

## 6. WASM Init Helper

**File:** `plugins/wasm.ts`

Provides a `.wasm?init` query syntax for deferred WASM instantiation:

```ts
import init from "./module.wasm?init";

const instance = await init({ /* importObject */ });
```

The plugin generates:

```ts
import wasm from "./module.wasm";    // handled by additionalModulesPlugin
export default function(opts = {}) {
  return WebAssembly.instantiate(wasm, opts);
}
```

---

## 7. Node.js Compatibility

**Files:** `nodejs-compat.ts`, `plugins/nodejs-compat.ts`

### `NodeJsCompat` Class

Created per worker when `nodejs_compat` (v2 mode) is enabled. Uses `unenv` with `@cloudflare/unenv-preset`:

```ts
const { env } = defineEnv({
  presets: [
    getCloudflarePreset({
      compatibilityDate: workerConfig.compatibility_date,
      compatibilityFlags: workerConfig.compatibility_flags,
    }),
  ],
});
```

From the resolved `env`, it extracts:
- **`externals`**: Node.js modules handled by the runtime (marked as builtins)
- **`alias`**: Maps like `"fs"` → `"unenv/runtime/node/fs"`
- **`inject`**: Globals to inject (e.g., `Buffer`, `process`)
- **`polyfill`**: Side-effect polyfill modules

### `nodeJsCompatPlugin` (enforce: "pre")

**`configEnvironment` hook:**
- Adds all externals to `resolve.builtins` so Vite treats them as platform builtins
- For Rolldown (Vite 8+): adds `esmExternalRequirePlugin` to handle `require()` calls to builtins

**`resolveId` hook** (filter: `nodeBuiltinsRE`, `unenv/`, `@cloudflare/unenv-preset/`):

- Calls `nodeJsCompat.resolveNodeJsImport(source)` to check for an alias
- **Dev mode**: Registers the polyfill with Vite's dependency optimizer (`registerMissingImport`) for pre-bundling, then re-resolves
- **Build mode**: Returns the absolute path to the polyfill

**`configureServer` hook:**
- Pre-optimizes all Node.js compat entry points with the dependency optimizer before the first request

### Mode Support

Only v2 mode is supported. If v1 is detected, it throws:
```
Unsupported Node.js compat mode (v1). Only the v2 mode is supported,
either change your compat date to "2024-09-23" or later, or set the
"nodejs_compat_v2" compatibility flag
```

---

## 8. Node.js Compat Warnings

**File:** `plugins/nodejs-compat.ts` (`nodeJsCompatWarningsPlugin`)

For workers **without** `nodejs_compat` enabled:

- **`resolveId` (enforce: "pre")**: Catches `node:*` and unprefixed Node.js builtin imports
- Registers the import source and importer file
- Marks as **external** (to avoid build errors)
- On idle (500ms debounce) or process exit, renders aggregated warnings:
  ```
  Unexpected Node.js imports for environment "worker".
  Do you need to enable the "nodejs_compat" compatibility flag?
   - "node:fs" imported from "src/index.ts"
  ```

---

## 9. Node.js ALS Support

**File:** `plugins/nodejs-compat.ts` (`nodeJsAlsPlugin`)

When the compat mode is `"als"` (AsyncLocalStorage only, not full v2):
- Adds `async_hooks` and `node:async_hooks` to `resolve.builtins`
- Excludes them from dependency optimization

---

## 10. Build Orchestration

**File:** `build.ts`

The `createBuildApp()` function orchestrates multi-environment builds:

1. **Build all Worker environments** in parallel
2. **Load the entry worker's Vite manifest** (`.vite/manifest.json`) to find imported assets
3. **Build the client environment** (if there's an HTML entry, public assets, or imported assets)
4. **Move assets** from worker output to client output (dedup if already exists)
5. **Remove `assets` field** from entry worker's `wrangler.json` if no client build was needed

This ensures assets imported in Worker code (e.g., images referenced in responses) end up in the client/assets output where Cloudflare's asset serving can find them.

---

## 11. Output Configuration

**File:** `plugins/output-config.ts`

### `generateBundle` hook

Emits `wrangler.json` for each Worker environment:

```ts
{
  ...inputWorkerConfig,          // User's original wrangler config
  main: entryChunk.fileName,    // Output chunk filename (e.g., "index.js")
  no_bundle: true,              // Already bundled by Vite — tell wrangler not to re-bundle
  rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
  assets: {
    directory: "../client",     // Relative path to client output
  },
}
```

Key detail: **`no_bundle: true`** — because Vite has already bundled the Worker, the output `wrangler.json` tells wrangler to skip bundling during deployment.

Also:
- Infers `upload_source_maps: true` from Vite's `build.sourcemap` if not explicitly set
- Emits `.dev.vars` for preview mode
- Emits `.assetsignore` in client output (excludes `wrangler.json`, `.dev.vars` from asset upload)

---

## 12. Source Map Handling

- Vite/Rollup handles source maps through the standard transform chain
- The `additionalModulesPlugin` uses `MagicString.generateMap({ hires: "boundary" })` when replacing `__CLOUDFLARE_MODULE__` references in `renderChunk`
- The `outputConfigPlugin` infers `upload_source_maps: true` from Vite's `build.sourcemap` setting

---

## 13. Key Data Structures

### ResolvedWorkerConfig

```ts
// From plugin-config.ts — the resolved worker configuration
interface ResolvedWorkerConfig {
  name: string;
  main: string;                    // Entry point path
  compatibility_date: string;
  compatibility_flags?: string[];
  configPath?: string;
  assets?: { directory: string; ... };
  // ... all other wrangler.json fields
}
```

### NodeJsCompat

```ts
class NodeJsCompat {
  externals: Set<string>;          // Node modules handled by runtime
  entries: Set<string>;            // Polyfill entry points to bundle

  isGlobalVirtualModule(source: string): boolean;
  getGlobalVirtualModule(source: string): string | undefined;
  injectGlobalCode(): string;
  resolveNodeJsImport(source: string): { unresolved: string; resolved: string } | undefined;
}
```

---

## 14. Comparison with Wrangler

### Architectural Differences

| Aspect | Wrangler | Vite Plugin |
|--------|----------|-------------|
| **Bundler** | esbuild (hardcoded) | Rollup or Rolldown (via Vite) |
| **Plugin model** | esbuild plugins (`onResolve`/`onLoad`) | Rollup/Vite plugins (`resolveId`/`load`/`renderChunk`) |
| **Module collection** | Custom `ModuleCollector` esbuild plugin that intercepts imports and collects modules into an array for multipart upload | Rollup asset emission via `emitFile()` — modules become assets in the output |
| **Additional module naming** | SHA1 hash + original basename | Rollup's asset naming (content-hash based) |
| **Entry wrapping** | Middleware facade (file generation + re-bundle) | Virtual module (`virtual:cloudflare/worker-entry`) |
| **Format detection** | Separate esbuild scan pass | Not needed — only supports ESM |
| **Service-worker format** | Supported (IIFE output) | Not supported |
| **Node.js compat modes** | null, als, v1, v2 | Only v2 (throws on v1) |
| **Node.js global injection** | esbuild `inject` option pointing to virtual files | Virtual module imports at top of entry |
| **`unenv` integration** | `npmShims: true` (includes npm shim wrappers) | `npmShims` not set (defaults) |
| **CJS `require()` handling** | Custom virtual ESM wrappers per `require()` call | Rolldown's `esmExternalRequirePlugin` (Vite 8+) |
| **Alias precedence** | Custom alias plugin before unenv plugin | Vite's built-in resolve handles it |
| **Middleware** | 4 dev middleware (facade system) | None — handled by Miniflare/runner |
| **`checked-fetch`** | Injected in dev | Not present |
| **Watch mode** | esbuild context + custom module watchers | Vite's built-in watch/HMR |
| **Output format** | ESM or IIFE | ESM only |
| **Post-build deployment config** | N/A (wrangler IS the deployer) | Emits `wrangler.json` with `no_bundle: true` |
| **Multi-worker** | Sequential builds | Parallel builds via Vite Environment API |

### What the Vite Plugin Does NOT Do

1. **No format detection** — Only supports ESM (modules format). No service-worker support.
2. **No middleware system** — Dev middleware (drain body, JSON error, scheduled) is handled by the Miniflare/runner infrastructure, not by code injection.
3. **No `checked-fetch`** — The custom-port warning proxy is not implemented.
4. **No legacy module support** — No wrangler 1.x bare specifier handling.
5. **No `find_additional_modules`** — Filesystem scanning for additional modules is not present; only import-based discovery.
6. **No Python support** — No `cf-requirements.txt`, no `python_modules/` directory.
7. **No `__STATIC_CONTENT_MANIFEST`** — Workers Sites are not supported.
8. **No custom build command** — `config.build` (custom build step) is not run.

### What the Vite Plugin Does Differently

1. **Asset emission via Rollup** — Instead of collecting modules into an array and writing them to disk, the plugin uses Rollup's `emitFile` to emit assets, and Rollup handles deduplication, content-hashing, and relative path computation.

2. **Virtual entry module** — Instead of generating a facade file on disk and re-pointing esbuild at it, the plugin uses Vite's virtual module system. This is cleaner and doesn't require temp directories.

3. **Node.js globals via entry-point imports** — Instead of esbuild's `inject` option (which prepends files), the plugin generates import statements at the top of the virtual entry module. The effect is the same — globals are set before user code runs.

4. **Dependency pre-bundling** — In dev mode, the plugin uses Vite's dependency optimizer to pre-bundle `unenv` polyfills, avoiding on-the-fly bundling during requests.

5. **`no_bundle: true` output** — The output `wrangler.json` tells wrangler to skip bundling during `wrangler deploy`. Wrangler just uploads the already-bundled output.

### Common Ground (Both Do This)

1. **`unenv` + `@cloudflare/unenv-preset`** — Both use the same underlying polyfill system for Node.js v2 compat.
2. **ES2024 target** — Both target ES2024.
3. **`cloudflare:*` as external/builtin** — Both mark Cloudflare internal modules as external.
4. **Same module rules** — `.wasm`, `.bin`, `.txt`, `.html`, `.sql` with the same type mappings.
5. **Same `process.env.NODE_ENV` replacement** — Both replace `process.env.NODE_ENV` (and `global.*`, `globalThis.*` variants).
6. **Same resolve conditions** — `workerd`, `worker`, `browser` (Vite adds `module`).
7. **`preserveEntrySignatures: "strict"`** — Both ensure exports aren't mangled (Wrangler achieves this implicitly via single-entry esbuild).

---

## 15. Porting Considerations

### The Vite plugin is a better analog for `unplugin`

The Vite plugin's approach maps much more directly to `unplugin` because:

1. **It already uses Rollup plugin hooks** (`resolveId`, `load`, `renderChunk`) which are exactly what `unplugin` exposes.
2. **The additional modules pattern** (resolve → mark external with encoded ID → renderChunk to emit asset and fix references) is a clean pattern that translates directly.
3. **Virtual modules** for entry wrapping and Node.js global injection use standard Rollup conventions.
4. **No middleware system** to worry about for production builds.

### What to port from the Vite plugin

1. **Additional modules plugin** — The `resolveId` + `renderChunk` pattern for `.wasm`, `.bin`, `.txt`, `.html`, `.sql`. This is the cleanest implementation of the module collection concern.

2. **Node.js compat plugin** — The `NodeJsCompat` class and its `resolveId` hook. The virtual module pattern for global injection is elegant.

3. **WASM init helper** — Small but useful `.wasm?init` support.

4. **Node.js compat warnings** — The warning aggregation pattern for missing `nodejs_compat`.

### What to port from Wrangler instead

1. **Module rules system** — Wrangler's configurable rules with `fallthrough` are more flexible than the Vite plugin's hardcoded patterns. Users should be able to add custom rules.

2. **`find_additional_modules`** — Filesystem-based module discovery is important for `--no-bundle` workflows and for discovering modules that aren't imported directly.

3. **Module naming with SHA1** — For deterministic, collision-resistant naming outside of Rollup's asset pipeline.

### Things we probably don't need

1. **Format detection** — If we only support ESM (as the Vite plugin does), we don't need the scan pass.
2. **Service-worker format** — Legacy; ESM-only is the right call.
3. **Middleware system** — Dev-only concern, defer.
4. **Legacy 1.x module support** — Deprecated.
5. **`checked-fetch`** — Dev-only concern.
6. **Python support** — Can defer.
7. **`__STATIC_CONTENT_MANIFEST`** — Workers Sites is legacy.
