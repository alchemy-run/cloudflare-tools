# Wrangler Bundling Pipeline — Full Audit

> Source: `workers-sdk/packages/wrangler/src/deployment-bundle/`

This document catalogs every stage, plugin, and behavior of Wrangler's bundling pipeline, as identified by reading the source code in the `workers-sdk` submodule. The goal is to serve as a reference for porting this functionality into `@distilled.cloud/cloudflare-bundler`.

---

## Table of Contents

1. [Pipeline Overview](#1-pipeline-overview)
2. [Entry Point Resolution](#2-entry-point-resolution)
3. [Worker Format Detection](#3-worker-format-detection)
4. [Middleware System](#4-middleware-system)
5. [Injected Code](#5-injected-code)
6. [esbuild Configuration](#6-esbuild-configuration)
7. [Plugin Chain](#7-plugin-chain)
   - 7.1 [Alias Plugin](#71-alias-plugin)
   - 7.2 [Module Collector Plugin](#72-module-collector-plugin)
   - 7.3 [Node.js Compat Plugins](#73-nodejs-compat-plugins)
   - 7.4 [Cloudflare Internal Plugin](#74-cloudflare-internal-plugin)
   - 7.5 [Build Result Plugin](#75-build-result-plugin)
   - 7.6 [User Plugins](#76-user-plugins)
   - 7.7 [Config Provider Plugin](#77-config-provider-plugin)
8. [Module Rules & Additional Modules](#8-module-rules--additional-modules)
9. [Post-Build Processing](#9-post-build-processing)
10. [Source Map Handling](#10-source-map-handling)
11. [Build Failure Rewriting](#11-build-failure-rewriting)
12. [Watch Mode](#12-watch-mode)
13. [No-Bundle Mode](#13-no-bundle-mode)
14. [Key Data Structures](#14-key-data-structures)
15. [Porting Considerations](#15-porting-considerations)

---

## 1. Pipeline Overview

The high-level flow of `bundleWorker()` (in `bundle.ts`) is:

```
Entry Resolution (entry.ts)
    ↓
Custom Build Command (if configured)
    ↓
Format Detection (guess-worker-format.ts) — lightweight esbuild scan
    ↓
Middleware Facade Application (apply-middleware.ts)
    ↓
Prepare Injected Files (checked-fetch, modules-watch-stub, middleware injects)
    ↓
Construct esbuild Build Options:
  - Plugin chain (7 categories, ordered)
  - Conditions, platform, defines, externals
  - Target: ES2024
    ↓
Execute esbuild.build() or esbuild.context().watch()
    ↓
Post-Build:
  - Extract entry point info from metafile
  - Validate Durable Object / Workflow exports
  - Dedupe & write additional modules
  - Return BundleResult
```

---

## 2. Entry Point Resolution

**File:** `entry.ts`, `resolve-entry.ts`

The `getEntry()` function resolves the Worker entry point with a fallback chain:

1. `--script` CLI argument → `resolveEntryWithScript()`
2. `config.main` → `resolveEntryWithMain()`
3. `config.site["entry-point"]` (legacy Sites) → `resolveEntryWithEntryPoint()`
4. `config.assets` or `--assets` → `resolveEntryWithAssets()`
5. None of the above → throws a `UserError` with detailed instructions

After resolution, it:
- Runs any custom build command (`config.build`) via `runCustomBuild()`
- Detects the format (modules vs service-worker) via `guessWorkerFormat()`
- Validates that service workers don't use local Durable Object bindings
- Determines `moduleRoot` (where `--no-bundle` modules live, defaults to `path.dirname(entryFile)`)

**Output:** An `Entry` object:
```ts
type Entry = {
  file: string;           // Absolute path to entrypoint
  projectRoot: string;    // Usually config file directory
  configPath: string | undefined;
  format: "modules" | "service-worker";
  moduleRoot: string;     // Root for additional module discovery
  name?: string;          // Worker name
  exports: string[];      // Detected exports from the entrypoint
};
```

---

## 3. Worker Format Detection

**File:** `guess-worker-format.ts`

Uses a lightweight, **non-bundling** esbuild build to scan for exports:

```ts
const result = await esbuild.build({
  target: "es2024",
  loader: { ".js": "jsx", ".mjs": "jsx", ".cjs": "jsx" },
  entryPoints: [entryFile],
  metafile: true,
  bundle: false,
  write: false,
  logLevel: "silent",
});
```

Decision logic:
- **Has `default` export** → `"modules"` format
- **Has other exports but no `default`** → warns, falls back to `"service-worker"`
- **No exports** → `"service-worker"`
- **`.py` extension** → always `"modules"` (Python worker)

---

## 4. Middleware System

**Files:** `apply-middleware.ts`, `templates/middleware/`

Middleware are composable wrappers applied to the Worker's fetch handler. They use a chain-of-responsibility pattern defined in `templates/middleware/common.ts`.

### Middleware Interface

```ts
type Middleware = (
  request: IncomingRequest,
  env: any,
  ctx: ExecutionContext,
  middlewareCtx: {
    dispatch: Dispatcher;
    next(request: IncomingRequest, env: any): Awaitable<Response>;
  }
) => Awaitable<Response>;
```

### Built-in Middleware

| Name | Path | Condition | Purpose |
|------|------|-----------|---------|
| `ensure-req-body-drained` | `templates/middleware/middleware-ensure-req-body-drained.ts` | `targetConsumer === "dev"` and env var not set | Drains unconsumed request bodies in dev to prevent connection issues |
| `scheduled` | `templates/middleware/middleware-scheduled.ts` | `targetConsumer === "dev"` and `testScheduled` | Intercepts `/__scheduled` path to trigger scheduled handlers via HTTP |
| `miniflare3-json-error` | `templates/middleware/middleware-miniflare3-json-error.ts` | `targetConsumer === "dev"` and `local` | Wraps errors as JSON with `MF-Experimental-Error-Stack` header for pretty error pages |
| `patch-console-prefix` | `templates/middleware/middleware-patch-console-prefix.ts` | `MULTIWORKER` flag | Prefixes console.log/debug/info with worker name for multi-worker disambiguation |

### Application Mechanism

The middleware system works differently for each format:

**Modules format:**
1. Generates a **facade file** (`middleware-insertion-facade.js`) that:
   - Imports the original worker as `worker`
   - Re-exports all named exports from the original
   - Exports `__INTERNAL_WRANGLER_MIDDLEWARE__` array of middleware functions
   - Re-exports `worker` as default
2. Generates a **loader** (`middleware-loader.entry.ts`) based on `templates/middleware/loader-modules.ts` that:
   - Imports the facade
   - Wraps `ExportedHandler` objects via `wrapExportedHandler()` — intercepts `fetch()` to run through middleware chain
   - Wraps `WorkerEntrypoint` classes via `wrapWorkerEntrypoint()` — extends the class, overrides `fetch()`
   - The loader becomes the new entrypoint for esbuild

**Service-worker format:**
1. Generates a facade file that calls `__facade_registerInternal__()` with middleware functions
2. This facade is added to esbuild's `inject` array (prepended to the bundle)
3. The original entry point is unchanged

### Middleware Config

Middleware can expose configuration via `config:middleware/{name}` virtual modules (resolved by the Config Provider Plugin). Example: `patch-console-prefix` imports `{ prefix }` from `"config:middleware/patch-console-prefix"`.

---

## 5. Injected Code

**Injected via esbuild's `inject` option** (prepended to the output bundle):

### 5.1 `checked-fetch.js`

**Condition:** `checkFetch` is true (controlled by `shouldCheckFetch()`)

Patches `globalThis.fetch` with a Proxy that warns when making HTTPS requests to custom ports (which are ignored in production). This is gated by compatibility date/flags:
- `ignore_custom_ports` flag → enable check
- `allow_custom_ports` flag → disable check
- `compatibilityDate < "2024-09-02"` → enable check (default)

### 5.2 `modules-watch-stub.js`

**Condition:** `watch` mode is enabled

A one-liner that imports the virtual module `"wrangler:modules-watch"`, which triggers the Module Collector's `onLoad` handler to register filesystem watchers.

### 5.3 Middleware Inject (service-worker only)

When middleware is applied to a service-worker format Worker, the middleware registration facade is injected.

### 5.4 Node.js Global Polyfills (v2 compat mode)

The hybrid Node.js compat plugin adds virtual modules to `build.initialOptions.inject` for `unenv` global polyfills (e.g., `globalThis.Buffer`, `globalThis.process`).

---

## 6. esbuild Configuration

**File:** `bundle.ts`

### Common Options

```ts
const COMMON_ESBUILD_OPTIONS = {
  target: "es2024",
  loader: { ".js": "jsx", ".mjs": "jsx", ".cjs": "jsx" },
};
```

All `.js`, `.mjs`, and `.cjs` files are loaded with the `jsx` loader, enabling JSX syntax universally.

### Full Build Options

| Option | Value | Notes |
|--------|-------|-------|
| `entryPoints` | `[entry.file]` | After middleware transformation |
| `bundle` | from config | `false` for `--no-bundle` |
| `absWorkingDir` | `entry.projectRoot` | |
| `keepNames` | from config | Preserves function/class `.name` |
| `outdir` / `outfile` | `destination` | `outfile` if `isOutfile`, else `outdir` |
| `entryNames` | `entryName` or parsed from entry filename | |
| `inject` | accumulated array | checked-fetch, modules-watch, middleware |
| `external` | `["__STATIC_CONTENT_MANIFEST", ...userExternals]` | Only when bundling |
| `format` | `"esm"` for modules, `"iife"` for service-worker | |
| `target` | `"es2024"` | |
| `sourcemap` | user config, defaults to `true` | |
| `sourceRoot` | `destination` | Needed for error source path resolution |
| `minify` | from config | |
| `metafile` | `true` | Always; optionally written to disk |
| `conditions` | `["workerd", "worker", "browser"]` | Overridable via `WRANGLER_BUILD_CONDITIONS` env var |
| `platform` | `"browser"` (default) | Overridable via `WRANGLER_BUILD_PLATFORM` env var |
| `logLevel` | `"silent"` | Errors are rewritten and logged manually |

### Defines

```ts
define: {
  "navigator.userAgent": '"Cloudflare-Workers"',     // if defineNavigatorUserAgent
  "process.env.NODE_ENV": '"production"' | '"development"',
  "global.process.env.NODE_ENV": /* same */,
  "globalThis.process.env.NODE_ENV": /* same */,
  ...userDefine,
}
```

`NODE_ENV` is `"production"` for deploy, `"development"` for dev.

---

## 7. Plugin Chain

Plugins are applied in this exact order:

```ts
plugins: [
  aliasPlugin,                    // 7.1
  moduleCollector.plugin,         // 7.2
  ...getNodeJSCompatPlugins(),    // 7.3
  cloudflareInternalPlugin,       // 7.4
  buildResultPlugin,              // 7.5
  ...(userPlugins || []),         // 7.6
  configProviderPlugin(...),      // 7.7
]
```

### 7.1 Alias Plugin

**Defined inline in `bundle.ts`**

Reimplements esbuild's `alias` option as a plugin to ensure **user-defined aliases take precedence over `unenv` polyfill aliases** (since esbuild's native `alias` is applied _after_ plugin `onResolve` hooks).

- Creates a regex filter matching all alias keys for performance
- Uses `require.resolve()` from the project root (matching esbuild's alias resolution behavior of resolving from the working directory, not the importing file)

### 7.2 Module Collector Plugin

**File:** `module-collection.ts`

The most complex plugin. Responsible for intercepting non-JS imports (WASM, text, data, etc.) and collecting them as separate modules for the Workers upload.

#### `onStart()`:
- Resets the modules array
- If `findAdditionalModules` is enabled, scans the filesystem under `moduleRoot` for matching files and populates the modules array

#### `wrangler:modules-watch` virtual module:
- Registers file watchers for found modules (used in watch mode)
- Registers directory watchers for new file detection

#### Legacy 1.x module support:
- Detects bare module specifiers (e.g., `import wasm from "my-module.wasm"` without `./`)
- Warns about deprecation, resolves them anyway
- Hashes file content with SHA1, renames to `${hash}-${basename}` (unless `preserveFileNames`)

#### Rule-based module resolution:
For each rule (parsed from config + defaults), registers an `onResolve` handler:

1. If the file was found by `findAdditionalModules`, marks as external (already in the modules array)
2. For JavaScript module rules, only acts when `findAdditionalModules` is enabled
3. For non-JS rules: reads the file, hashes it, adds to modules array, returns as external
4. Resolution: tries `build.resolve()` first (respects package.json exports), then `resolveSync()` from the `resolve` package (Node resolution)

#### Service-worker format special handling:
For service-worker format, an `onLoad` handler replaces module content with:
```js
export default my_module_wasm;  // identifier for form upload
```
The identifier is derived by replacing non-alphanumeric chars with `_`.

### 7.3 Node.js Compat Plugins

**Files:** `nodejs-plugins.ts`, `nodejs-compat.ts`, `hybrid-nodejs-compat.ts`, `als-external.ts`

Four compatibility modes, returning different plugin combinations:

| Mode | Plugins | Trigger |
|------|---------|---------|
| `null` | `nodejsCompatPlugin(null)` | No compat flags set |
| `"als"` | `asyncLocalStoragePlugin` + `nodejsCompatPlugin("als")` | `nodejs_compat` flag without full v2 |
| `"v1"` | `nodejsCompatPlugin("v1")` | Legacy `nodejs_compat` |
| `"v2"` | `nodejsHybridPlugin()` | Modern `nodejs_compat_v2` or `nodejs_compat` with recent compat date |

#### `nodejsCompatPlugin` (modes: null, als, v1)

- **`onResolve` for `node:*`**: Attempts to resolve normally first (for polyfill packages). If resolution fails, marks as external and tracks the import.
- **Infinite loop prevention**: Uses a `seen` Set keyed by `${path}:${kind}:${resolveDir}:${importer}`.
- **`onEnd` (service-worker check)**: If format is IIFE and any `node:*` imports were marked external, errors with a message suggesting ES module format.
- **`onEnd` (warning)**: For modes other than `v1`, logs a warning per unresolved `node:*` package listing all importers, suggesting the `nodejs_compat` flag.

#### `nodejsHybridPlugin` (mode: v2)

Uses [`unenv`](https://github.com/nicolo-ribaudo/unenv) with `@cloudflare/unenv-preset`:

```ts
const { alias, inject, external, polyfill } = defineEnv({
  presets: [getCloudflarePreset({ compatibilityDate, compatibilityFlags })],
  npmShims: true,
}).env;
```

Provides four capabilities:

1. **`errorOnServiceWorkerFormat()`**: Collects all `node:*` imports; if format is IIFE, errors.
2. **`handleRequireCallsToNodeJSBuiltins()`**: Converts `require("node:X")` calls to virtual ESM wrappers:
   ```js
   import libDefault from 'node:X';
   module.exports = libDefault;
   ```
3. **`handleUnenvAliasedPackages()`**: Resolves unenv aliases to absolute paths. For `require()` calls to `unenv/npm/*` or `unenv/mock/*`, wraps in virtual ESM:
   ```js
   import * as esm from 'X';
   module.exports = Object.entries(esm)
     .filter(([k,]) => k !== 'default')
     .reduce((cjs, [k, value]) =>
       Object.defineProperty(cjs, k, { value, enumerable: true }),
       "default" in esm ? esm.default : {}
     );
   ```
4. **`handleNodeJSGlobals()`**: Creates virtual modules for each `inject` entry from `unenv` and adds them to `build.initialOptions.inject`. Each virtual module does:
   ```js
   import { X as Y } from "unenv/runtime/node/...";
   globalThis.X = Y;
   ```
   Polyfills are injected directly via `require.resolve()`.

**Special case:** The `debug` package is force-aliased to itself (not unenv's no-op stub).

#### `asyncLocalStoragePlugin` (mode: als)

Simply marks `node:async_hooks` (and subpaths) as external.

### 7.4 Cloudflare Internal Plugin

**File:** `cloudflare-internal.ts`

- Marks all `cloudflare:*` imports as external
- On end: if format is IIFE (service-worker) and `cloudflare:*` imports were found, errors suggesting ES module format

### 7.5 Build Result Plugin

**Defined inline in `bundle.ts`**

In watch mode, `esbuild.context().watch()` doesn't return build results directly. This plugin captures the initial build result via `onEnd` and resolves a Promise that the outer code awaits.

### 7.6 User Plugins

Any plugins passed via `BundleOptions.plugins` are inserted here — after the core plugins but before the config provider.

### 7.7 Config Provider Plugin

**File:** `config-provider.ts`

Provides virtual `config:middleware/*` modules. When middleware declares a `config` record:
```ts
middlewareToLoad.push({
  name: "patch-console-prefix",
  config: { prefix: "[worker-name]" },
  ...
});
```
The plugin resolves `import { prefix } from "config:middleware/patch-console-prefix"` to a JSON module containing that config.

---

## 8. Module Rules & Additional Modules

### 8.1 Default Rules

**File:** `rules.ts`

```ts
const DEFAULT_MODULE_RULES: Rule[] = [
  { type: "Text", globs: ["**/*.txt", "**/*.html", "**/*.sql"] },
  { type: "Data", globs: ["**/*.bin"] },
  { type: "CompiledWasm", globs: ["**/*.wasm", "**/*.wasm?module"] },
];
```

### 8.2 Rule Parsing

User rules are prepended to defaults. The `fallthrough` mechanism controls whether multiple rules of the same type are allowed:

- `fallthrough: true` → subsequent rules of the same type are also active
- `fallthrough: false` (or omitted) → subsequent same-type rules are removed and a warning is logged
- Removed rules are still tracked; if a file matches a removed rule, it throws a `UserError`

### 8.3 Module Type Mapping

```ts
const RuleTypeToModuleType = {
  ESModule: "esm",
  CommonJS: "commonjs",
  CompiledWasm: "compiled-wasm",
  Data: "buffer",
  Text: "text",
  PythonModule: "python",
  PythonRequirement: "python-requirement",
};
```

### 8.4 Additional Module Discovery

**File:** `find-additional-modules.ts`

When `find_additional_modules` is enabled (or for `--no-bundle` workers):

1. Recursively walks `entry.moduleRoot`
2. Skips `.wrangler` hidden directory and `node_modules`
3. Skips the config file and entry point
4. Matches files against parsed rules using `glob-to-regexp`
5. Deduplicates by module name
6. For Python entrypoints: reads `cf-requirements.txt`, discovers `python_modules/` directory

### 8.5 Module Deduplication

**File:** `dedupe-modules.ts`

After build, modules from `moduleCollector` (found during bundling) and `additionalModules` (provided externally) are merged. Deduplication is by name, with later entries (additionalModules) winning.

### 8.6 Module Naming

By default, modules are renamed to `${sha1Hash}-${originalBasename}` to prevent collisions. When `preserveFileNames` is set, the original import path is used as-is.

---

## 9. Post-Build Processing

### 9.1 Entry Point Extraction

**File:** `entry-point-from-metafile.ts`

After esbuild completes, scans `metafile.outputs` for the single entry with `entryPoint !== undefined`. Extracts:
- `relativePath` — output path relative to outdir
- `exports` — the exported names
- `dependencies` — input files that contributed to this output

### 9.2 Export Validation

Validates that all locally-bound Durable Objects and Workflows are exported from the entry point. Throws `UserError` if any are missing, with a message naming the un-exported classes.

### 9.3 Bundle Type Determination

```ts
const bundleType = entryPoint.exports.length > 0 ? "esm" : "commonjs";
```

### 9.4 Module Writing

`writeAdditionalModules()` copies all collected modules to the output directory adjacent to the entry point, preserving directory structure. Source maps are written alongside if present.

---

## 10. Source Map Handling

**File:** `source-maps.ts`

Two strategies for loading source maps:

### 10.1 Wrangler-Bundled Maps

When Wrangler bundled the worker (has `sourceMapPath` and `sourceMapMetadata`):
1. Reads the map file from `${entryDirectory}/${sourceMapPath}`
2. Sets `map.file` to the module name (for multipart upload)
3. Normalizes `sourceRoot` — removes the temporary directory prefix
4. Normalizes `sources` paths relative to the entry directory

### 10.2 Scanned Maps (user-provided modules)

For modules not bundled by Wrangler:
1. Scans module content for `//# sourceMappingURL=` comments
2. Resolves the URL relative to the module's file path
3. Reads and normalizes the map
4. Rejects data URLs (inline source maps)

### 10.3 Additional Module Source Maps

`tryAttachSourcemapToModule()` attaches source maps to ESM/CommonJS modules found during additional module discovery. These are written alongside the module in the output.

---

## 11. Build Failure Rewriting

**File:** `build-failures.ts`

When esbuild fails to resolve a Node.js built-in module, the error is rewritten with actionable advice:

| Compat Mode | Suggestion |
|-------------|------------|
| `null` or `"als"` | Add the `nodejs_compat` compatibility flag |
| `"v1"` (without `node:` prefix) | Prefix the module name with `node:` or update `compatibility_date` to `2024-09-23+` |
| `"v2"` | (no rewrite needed — unenv handles resolution) |

The regex matches all of Node's `builtinModules` with and without `node:` prefix.

---

## 12. Watch Mode

When `watch: true`:

1. Uses `esbuild.context()` + `ctx.watch()` instead of `esbuild.build()`
2. The initial build result is captured by the Build Result Plugin
3. The `modules-watch-stub.js` inject triggers the Module Collector's watch registration
4. **File watches**: All found additional modules are watched for changes/deletions
5. **Directory watches**: All directories under `moduleRoot` (excluding `node_modules`, `.git`) are watched for new files
6. The `stop()` function disposes the esbuild context and cleans up the temp directory

---

## 13. No-Bundle Mode

**File:** `no-bundle-worker.ts`

When `--no-bundle` is specified:
- Skips esbuild entirely
- Uses `findAdditionalModules()` to discover modules under `moduleRoot`
- Writes discovered modules to `outDir`
- Returns a minimal `BundleResult` with the entry file as-is

---

## 14. Key Data Structures

### BundleResult

```ts
type BundleResult = {
  modules: CfModule[];
  dependencies: esbuild.Metafile["outputs"][string]["inputs"];
  resolvedEntryPointPath: string;
  bundleType: "esm" | "commonjs";
  stop: (() => Promise<void>) | undefined;
  sourceMapPath?: string;
  sourceMapMetadata?: { tmpDir: string; entryDirectory: string };
};
```

### CfModule

```ts
type CfModule = {
  name: string;          // Module identifier (potentially hashed)
  content: Buffer | string;
  type: CfModuleType;    // "esm" | "commonjs" | "compiled-wasm" | "text" | "buffer" | "python" | "python-requirement"
  filePath?: string;     // Original filesystem path
  sourceMap?: { name: string; content: string };
};
```

### BundleOptions

```ts
type BundleOptions = {
  bundle: boolean;
  additionalModules: CfModule[];
  moduleCollector: ModuleCollector;
  doBindings: DurableObjectBindings;
  workflowBindings: WorkflowBinding[];
  jsxFactory: string | undefined;
  jsxFragment: string | undefined;
  entryName: string | undefined;
  watch: boolean | undefined;
  tsconfig: string | undefined;
  minify: boolean | undefined;
  keepNames: boolean;
  nodejsCompatMode: NodeJSCompatMode | undefined;  // null | "als" | "v1" | "v2"
  compatibilityDate: string | undefined;
  compatibilityFlags: string[] | undefined;
  define: Config["define"];
  alias: Config["alias"];
  checkFetch: boolean;
  targetConsumer: "dev" | "deploy";
  testScheduled: boolean | undefined;
  inject: string[] | undefined;
  sourcemap: esbuild.CommonOptions["sourcemap"] | undefined;
  plugins: esbuild.Plugin[] | undefined;
  isOutfile: boolean | undefined;
  local: boolean;
  projectRoot: string | undefined;
  defineNavigatorUserAgent: boolean;
  external: string[] | undefined;
  metafile: string | boolean | undefined;
};
```

### MiddlewareLoader

```ts
interface MiddlewareLoader {
  name: string;
  path: string;
  config?: Record<string, unknown>;
  supports: ("modules" | "service-worker")[];
}
```

### ModuleCollector

```ts
type ModuleCollector = {
  modules: CfModule[];    // Mutable array populated during build
  plugin: esbuild.Plugin; // The esbuild plugin that populates it
};
```

---

## 15. Porting Considerations

### What's bundler-specific (needs `unplugin` adaptation)

1. **Module Collector Plugin** — The core of the non-JS module handling. Needs to be reimplemented as an unplugin that intercepts WASM/text/data/etc imports, collects them, and marks them as external. The `onResolve` + `onLoad` pattern maps well to unplugin's `resolveId` + `load` hooks.

2. **Node.js Compat Plugins** — The `unenv` integration (`v2` mode) is the most important. The virtual module pattern (`onResolve` to namespace + `onLoad` to generate code) is standard Rollup plugin territory. The `require()` call interception for CJS→ESM wrapping is trickier and may need bundler-specific handling.

3. **Alias Plugin** — Straightforward `resolveId` hook.

4. **Cloudflare Internal Plugin** — Simple `resolveId` hook marking `cloudflare:*` as external.

5. **Config Provider Plugin** — Virtual module pattern, straightforward.

### What's bundler-agnostic (can be shared directly)

1. **Entry Point Resolution** — Pure filesystem/config logic, no bundler dependency.
2. **Format Detection** — Currently uses esbuild for a scan pass, but the heuristic (has exports → modules format) could be implemented with any parser or even a simple regex.
3. **Middleware System** — The facade generation is template-based string manipulation. The middleware implementations themselves are just TypeScript modules.
4. **Module Rules & Discovery** — Pure filesystem walking + glob matching.
5. **Source Map Handling** — Source map normalization is bundler-agnostic.
6. **Build Failure Rewriting** — Error message transformation, not bundler-specific.

### Dev-only vs Production concerns

The middleware system is **almost entirely dev-only**:
- `ensure-req-body-drained` — dev only
- `scheduled` — dev only
- `miniflare3-json-error` — dev only, local only
- `patch-console-prefix` — dev only (MULTIWORKER flag)

For production (`targetConsumer === "deploy"`), no middleware is applied. This means the middleware system is relevant for our dev story but **not for the core bundling pipeline**.

### `checked-fetch` is also dev-only

It's gated by compatibility date and is a dev-time warning mechanism. For production, the runtime handles this.

### The `__STATIC_CONTENT_MANIFEST` external

This is always marked as external when bundling. It's a special import used by Workers Sites that is provided by the runtime.

### Python support

The additional modules system has significant Python-specific logic (requirements.txt parsing, `python_modules/` directory discovery, vendor module size tracking). This is worth noting but may be lower priority for initial implementation.
