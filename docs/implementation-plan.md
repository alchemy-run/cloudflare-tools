# Implementation Plan

This plan is informed by our audits of [Wrangler](./wrangler.md) and the [Cloudflare Vite plugin](./vite-plugin.md), and the discussions that followed. The Vite plugin's Rollup-native patterns are our primary reference for implementation, adapted through `unplugin` to support multiple bundlers.

---

## Table of Contents

1. [Scope](#1-scope)
2. [Architecture](#2-architecture)
3. [Plugin Breakdown](#3-plugin-breakdown)
4. [Effect-Native API](#4-effect-native-api)
5. [Bundler-Specific Concerns](#5-bundler-specific-concerns)
6. [Output](#6-output)
7. [Implementation Order](#7-implementation-order)
8. [Deferred Work](#8-deferred-work)

---

## 1. Scope

### In Scope (v1)

- **ESM-only** — No service-worker format, no format detection scan pass
- **unplugin-based plugins** for the core bundling concerns:
  - Cloudflare built-in externals (`cloudflare:*`)
  - Additional modules (WASM, text, data) with configurable rules
  - Node.js compatibility (v2 only, via `unenv` + `@cloudflare/unenv-preset`)
  - `process.env.NODE_ENV` and related defines
- **Bundler targets**: esbuild, Rolldown (rspack stretch goal)
- **Effect-native API** for configuring and running builds
- **Clean build output** — bundled entry + additional modules + a `BuildResult` describing what was produced. No deployment opinions.
- **Test suite** validating runtime correctness in Miniflare

### Out of Scope (v1)

- Dev server / watch mode / HMR
- Middleware system (dev-only in both Wrangler and Vite plugin)
- `checked-fetch` injection (dev-only)
- Service-worker format
- Python support
- Workers Sites / `__STATIC_CONTENT_MANIFEST`
- Legacy wrangler 1.x module references
- Filesystem-based module discovery (`find_additional_modules`)
- Node.js compat v1 / ALS-only mode (v2 only)
- Multi-worker orchestration (each worker is bundled independently)
- Vite plugin / dev tooling (future project)
- Miniflare replacement (future project)

---

## 2. Architecture

### Package Exports

The package uses subpath exports to keep bundler-specific dependencies isolated. You only import the bundler you're using — the others are never loaded.

```
@distilled.cloud/cloudflare-bundler
├── src/
│   ├── index.ts                   # Core types, config, Bundler service definition
│   ├── config.ts                  # Configuration types and defaults
│   ├── plugins/
│   │   ├── cloudflare-externals.ts    # cloudflare:* externals
│   │   ├── additional-modules.ts      # WASM, text, data module handling
│   │   ├── nodejs-compat.ts           # Node.js v2 compat via unenv
│   │   ├── defines.ts                 # process.env.NODE_ENV and related
│   │   └── index.ts                   # Aggregated plugin chain
│   ├── esbuild.ts                 # esbuild Layer (exports from @distilled.cloud/cloudflare-bundler/esbuild)
│   └── rolldown.ts               # Rolldown Layer (exports from @distilled.cloud/cloudflare-bundler/rolldown)
```

```jsonc
// package.json exports
{
  "exports": {
    ".": "./dist/index.js",
    "./esbuild": "./dist/esbuild.js",
    "./rolldown": "./dist/rolldown.js"
  }
}
```

### Service Model (Effect 4)

The `Bundler` is defined as a `ServiceMap.Service`. Each bundler implementation provides a `Layer` that satisfies it.

```ts
import { ServiceMap, Effect } from "effect";

// The Bundler service — bundler-agnostic interface
class Bundler extends ServiceMap.Service<Bundler>()({
  bundle: ServiceMap.Effect({
    success: BuildResult,
    failure: BuildError,
  }),
}) {}
```

Bundler implementations are separate layers:

```ts
// @distilled.cloud/cloudflare-bundler/esbuild
const EsbuildBundler: Layer<Bundler> = ...

// @distilled.cloud/cloudflare-bundler/rolldown
const RolldownBundler: Layer<Bundler> = ...
```

### Usage

```ts
import { Bundler } from "@distilled.cloud/cloudflare-bundler";
import { EsbuildBundler } from "@distilled.cloud/cloudflare-bundler/esbuild";

const program = Bundler.bundle(config);

// Provide the bundler implementation
program.pipe(Effect.provide(EsbuildBundler));
```

### Plugin Model

Each concern is implemented as a separate `unplugin`, then composed into a single plugin chain. This keeps concerns isolated and testable.

```ts
import { createUnplugin } from "unplugin";

// Each plugin is a standalone unplugin
export const cloudflareExternals = createUnplugin((options) => ({ ... }));
export const additionalModules = createUnplugin((options) => ({ ... }));
export const nodejsCompat = createUnplugin((options) => ({ ... }));
```

The bundler layers compose these plugins with the bundler-specific build API.

---

## 3. Plugin Breakdown

### 3.1 Cloudflare Externals

**Concern:** Mark `cloudflare:*` imports as external so the bundler doesn't try to resolve them.

**Hooks:**
- `resolveId`: Match `/^cloudflare:.*/`, return `{ id, external: true }`

**Reference:** Vite plugin's `cloudflareBuiltInModules` list + Wrangler's `cloudflare-internal.ts`.

**Modules to externalize:**
```ts
const CLOUDFLARE_BUILTINS = [
  "cloudflare:email",
  "cloudflare:node",
  "cloudflare:sockets",
  "cloudflare:workers",
  "cloudflare:workflows",
];
```

### 3.2 Additional Modules

**Concern:** Handle non-JS imports (`.wasm`, `.bin`, `.txt`, `.html`, `.sql`) — intercept them, collect them as separate modules, and ensure they appear in the output as external assets.

**Configuration:**
```ts
interface ModuleRule {
  type: "CompiledWasm" | "Data" | "Text";
  globs: string[];
}

const DEFAULT_MODULE_RULES: ModuleRule[] = [
  { type: "CompiledWasm", globs: ["**/*.wasm", "**/*.wasm?module"] },
  { type: "Data", globs: ["**/*.bin"] },
  { type: "Text", globs: ["**/*.txt", "**/*.html", "**/*.sql"] },
];
```

Users can add custom rules. The `fallthrough` mechanism from Wrangler is nice-to-have but not essential for v1 — we can start with a simple "first match wins" approach.

**Hooks:**
- `resolveId`: Match against rule globs. Resolve the file path, mark as external. On bundlers with asset emission (Rollup/Rolldown), encode the type + path into the ID (like the Vite plugin's `__CLOUDFLARE_MODULE__` pattern). On esbuild, read the file, hash the content, add to a collected modules list, and return the hashed name as external.
- `load` (esbuild only): For service-worker-style inline references if needed — but since we're ESM-only, this is likely unnecessary.
- `buildEnd` / `writeBundle`: On esbuild, write collected modules to the output directory. On Rollup/Rolldown, modules are already emitted as assets.

**Bundler-specific behavior:**

| Bundler | Strategy |
|---------|----------|
| Rollup/Rolldown | Use the Vite plugin's approach: encode module reference in the external ID during `resolveId`, emit as asset and fix references during `renderChunk` (if available via unplugin) or `writeBundle` |
| esbuild | Use Wrangler's approach: read file, SHA1 hash for naming, collect into array, write to output directory in `buildEnd` |

**Note on `renderChunk`:** unplugin does not expose `renderChunk`. We'll need to evaluate whether `transform` on the output or a `writeBundle` post-processing step can achieve the same effect. If not, we may need bundler-specific hooks (unplugin supports `rolldown: { renderChunk }` overrides).

### 3.3 Node.js Compatibility (v2)

**Concern:** Polyfill/alias Node.js built-in modules using `unenv` + `@cloudflare/unenv-preset`. Inject global polyfills (e.g., `Buffer`, `process`).

**Implementation:** Port the `NodeJsCompat` class from the Vite plugin, which wraps:

```ts
const { env } = defineEnv({
  presets: [
    getCloudflarePreset({
      compatibilityDate,
      compatibilityFlags,
    }),
  ],
});
```

From `env`, extract:
- **`alias`**: Maps like `"fs"` → `"unenv/runtime/node/fs"` → resolve to absolute paths
- **`external`**: Node.js modules handled by the Workers runtime (mark as external)
- **`inject`**: Globals to inject on `globalThis` (e.g., `Buffer`, `process`)
- **`polyfill`**: Side-effect polyfill modules to import

**Hooks:**
- `resolveId`: Match Node.js builtins (with and without `node:` prefix) and `unenv/` imports. If the module has an alias, resolve to the polyfill's absolute path. If it's in the externals list, mark as external.
- `load`: For virtual global injection modules — generate code like:
  ```ts
  import { Buffer as bufferExport } from "unenv/runtime/node/buffer";
  globalThis.Buffer = bufferExport;
  ```
- `buildStart`: (esbuild) Configure the `inject` option to include global polyfill modules.

**Entry wrapping:** The global polyfill imports need to execute before user code. Two approaches:
1. **Virtual entry module** (Vite plugin approach): Create a virtual entry that imports polyfills then re-exports the user's entry. This requires the caller to use our virtual entry as the build input.
2. **`inject` / banner** (Wrangler approach): Use the bundler's inject mechanism to prepend polyfill code. This is less invasive — the user's entry point stays the same.

We'll use approach 2 (inject/banner) as it's more compatible with being "just a plugin" rather than requiring control of the entry point. For esbuild, this maps to the `inject` option. For Rolldown, we can use `transform` on the entry module or a `banner` option.

### 3.4 Defines

**Concern:** Replace `process.env.NODE_ENV` and related globals.

**Implementation:** Not a plugin — just configuration passed to the bundler's `define` option.

```ts
const defines = {
  "process.env.NODE_ENV": JSON.stringify(mode),
  "global.process.env.NODE_ENV": JSON.stringify(mode),
  "globalThis.process.env.NODE_ENV": JSON.stringify(mode),
  // Without nodejs_compat:
  ...(!hasNodeJsCompat ? {
    "process.env": "{}",
    "global.process.env": "{}",
    "globalThis.process.env": "{}",
  } : {}),
};
```

Additionally, if `defineNavigatorUserAgent` is true:
```ts
"navigator.userAgent": '"Cloudflare-Workers"'
```

---

## 4. Effect-Native API

### Bundler Service

```ts
import { ServiceMap, Effect, Schema } from "effect";

class Bundler extends ServiceMap.Service<Bundler>()({
  bundle: ServiceMap.Effect({
    success: BuildResult,
    failure: BuildError,
  }),
}) {}
```

The `bundle` method takes a `BundlerConfig` and returns an Effect. The bundler implementation is provided via a Layer — you never call a bundler directly.

### Configuration

```ts
import { Schema } from "effect";

const BundlerConfig = Schema.Struct({
  /** Path to the worker entry point */
  entry: Schema.String,
  /** Output directory */
  outDir: Schema.String,
  /** Worker name */
  name: Schema.optional(Schema.String),
  /** Compatibility date */
  compatibilityDate: Schema.optional(Schema.String),
  /** Compatibility flags */
  compatibilityFlags: Schema.optional(Schema.Array(Schema.String)),
  /** Additional module rules beyond defaults */
  rules: Schema.optional(Schema.Array(ModuleRule)),
  /** Whether to minify */
  minify: Schema.optional(Schema.Boolean),
  /** Source map generation */
  sourcemap: Schema.optional(Schema.Boolean),
  /** Custom define replacements */
  define: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  /** Custom alias mappings */
  alias: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  /** External modules */
  external: Schema.optional(Schema.Array(Schema.String)),
  /** Build mode */
  mode: Schema.optional(Schema.Literal("production", "development")),
  /** Whether to define navigator.userAgent */
  defineNavigatorUserAgent: Schema.optional(Schema.Boolean),
});
```

### BuildResult

```ts
interface BuildResult {
  /** Path to the bundled entry point */
  entryPoint: string;
  /** Additional modules (WASM, text, data) included in the output */
  modules: Array<{
    name: string;
    type: "compiled-wasm" | "text" | "buffer";
    path: string;
  }>;
  /** Output directory */
  outDir: string;
  /** Source map path, if generated */
  sourceMapPath?: string;
}
```

### Usage

```ts
import { Bundler, BundlerConfig } from "@distilled.cloud/cloudflare-bundler";
import { EsbuildBundler } from "@distilled.cloud/cloudflare-bundler/esbuild";

const config: BundlerConfig = {
  entry: "./src/index.ts",
  outDir: "./dist",
  compatibilityDate: "2025-01-01",
  compatibilityFlags: ["nodejs_compat"],
};

// Build with esbuild
const result = await Bundler.bundle(config).pipe(
  Effect.provide(EsbuildBundler),
  Effect.runPromise,
);

// Swap to Rolldown — same code, different Layer
import { RolldownBundler } from "@distilled.cloud/cloudflare-bundler/rolldown";

const result = await Bundler.bundle(config).pipe(
  Effect.provide(RolldownBundler),
  Effect.runPromise,
);
```

---

## 5. Bundler-Specific Concerns

### esbuild

**Build configuration:**
```ts
{
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  target: "es2024",
  platform: "neutral",  // or "browser"
  conditions: ["workerd", "worker", "browser"],
  outdir,
  metafile: true,
  sourcemap,
  minify,
  define,
  external: [...cloudflareBuiltins, ...userExternals],
  plugins: [
    ...unpluginChain.esbuild(),
  ],
  loader: { ".js": "jsx", ".mjs": "jsx", ".cjs": "jsx" },
  inject: [...nodejsGlobalPolyfills],
  keepNames: true,
}
```

**Additional module handling:** Since esbuild lacks `emitFile`, we:
1. In `resolveId`: read the file, SHA1-hash the content, store in a collection map, return `{ id: hashedName, external: true }`
2. In `buildEnd` or post-build: write all collected modules to `outdir`

### Rolldown

**Build configuration:**
```ts
{
  input: { index: entry },
  output: {
    dir: outdir,
    format: "esm",
    sourcemap,
  },
  platform: "neutral",
  resolve: {
    conditionNames: ["workerd", "worker", "browser"],
  },
  define,
  external: [...cloudflareBuiltins, ...userExternals],
  plugins: [
    ...unpluginChain.rolldown(),
  ],
}
```

**Additional module handling:** Rolldown supports Rollup's `emitFile` API. We can use the Vite plugin's approach: encode module info in the external ID during `resolveId`, then emit as assets during `renderChunk` or `generateBundle`. Since unplugin doesn't expose `renderChunk`, we'll use Rolldown-specific plugin overrides.

---

## 6. Output

This bundler produces build artifacts and a `BuildResult` describing them. It has **no opinions about deployment** — the consumer (a future CLI tool, Wrangler alternative, or other tooling) decides how to upload/deploy the output.

### Output Directory Structure

```
outdir/
├── index.js                    # Bundled worker entry
├── index.js.map                # Source map (if enabled)
├── abc123-data.wasm            # Additional modules (hashed names for esbuild)
├── data-DxF3k2.wasm            # Additional modules (content-hashed for Rolldown)
```

### What the consumer gets

The `BuildResult` provides everything a deployment tool needs:
- The path to the bundled entry point
- A list of additional modules with their types and paths
- Source map path if generated

The consumer can then use this information to construct a multipart upload to the Cloudflare API, generate a `wrangler.json`, or do whatever else is needed. That's not our concern.

---

## 7. Implementation Order

### Phase 1: Core Plugin Chain

1. **Cloudflare Externals plugin** — Simplest plugin. Good starting point to establish the unplugin pattern, project structure, and basic tests.

2. **Defines** — Not a plugin, just build config. Implement as part of the bundler adapter layer.

3. **Additional Modules plugin** — The most architecturally interesting piece. Implement for esbuild first (simpler — hash + collect + write), then Rolldown (asset emission). This establishes the pattern for bundler-specific divergence within unplugin.

4. **Node.js Compat plugin** — Port the `NodeJsCompat` class from the Vite plugin. Implement `resolveId` for alias resolution, `load` for virtual global injection modules, and the entry-point injection mechanism.

### Phase 2: Bundler Layers & Effect API

5. **`Bundler` service definition** — The `ServiceMap.Service`, `BundlerConfig` schema, `BuildResult` and `BuildError` types.

6. **`EsbuildBundler` layer** — Wire up the plugin chain with esbuild's build API. Exported from `@distilled.cloud/cloudflare-bundler/esbuild`.

7. **`RolldownBundler` layer** — Wire up with Rolldown's build API. Handle asset emission differences. Exported from `@distilled.cloud/cloudflare-bundler/rolldown`.

### Phase 3: Testing

8. **Unit tests** for each plugin (mocked bundler context).

9. **Integration tests** — Full builds with esbuild and Rolldown, verifying output structure.

10. **Runtime tests** — Run bundled output in Miniflare, make fetch requests, assert responses. This is the gold standard from the PRD.

---

## 8. Deferred Work

These items are explicitly deferred but tracked for future consideration:

| Item | Reason | Priority |
|------|--------|----------|
| Dev server / watch mode | Dev tooling concern, not bundling | Future project |
| Middleware system | Dev-only in both Wrangler and Vite plugin | Future project |
| Service-worker format | Legacy; ESM is the standard | Low |
| Python support | Niche; complex additional module handling | Low |
| `find_additional_modules` | Not needed when we are the bundler | Low (dynamic import edge case) |
| Node.js compat v1 / ALS-only | Only v2 matters going forward | Low |
| rspack adapter | Stretch goal for v1, or v2 | Medium |
| Multi-worker orchestration | Each worker bundles independently | Medium |
| Vite plugin | Future project per PRD | Future project |
| Miniflare replacement | Future project per PRD | Future project |
| Module rule `fallthrough` | Nice-to-have; "first match wins" is fine for v1 | Low |
| `keepNames` configuration | Default to true like Wrangler; expose later | Low |
| Custom build commands | `config.build` from wrangler.json | Low |
| Metafile output | esbuild metafile / build analysis | Low |
