# Testing Strategy: Porting workers-sdk Tests

This document catalogs all bundling-related tests and fixtures in `workers-sdk` (both Wrangler and `@cloudflare/vite-plugin`), classifies them by relevance, and proposes a bundler-agnostic test harness for `@distilled.cloud/cloudflare-bundler`.

---

## 1. Test Harness Design

### Philosophy

Our gold standard for correctness is **runtime compatibility**: bundle the code, run it in Miniflare, make fetch requests, and check responses. Crucially, we use **Wrangler itself as the oracle** — if Wrangler produces a working bundle for a fixture, our bundler must too. This three-way comparison (Wrangler baseline vs. esbuild Layer vs. rolldown Layer) gives us confidence that we're actually testing the right behavior, not just asserting on our own assumptions.

### Proposed Structure

```
test/
├── harness.ts              # Shared: config parsing, Miniflare setup, output normalization
├── fixtures/               # Checked-in fixture workers (each with wrangler.jsonc)
│   ├── basic-worker/
│   │   ├── wrangler.jsonc
│   │   ├── src/index.ts
│   │   └── assertions.ts
│   ├── additional-modules/
│   │   ├── wrangler.jsonc
│   │   ├── src/index.ts
│   │   ├── data.bin
│   │   ├── page.html
│   │   ├── add.wasm
│   │   └── assertions.ts
│   ├── node-compat/
│   │   ├── wrangler.jsonc   # has nodejs_compat_v2 in compatibility_flags
│   │   ├── src/index.ts
│   │   └── assertions.ts
│   └── ...
└── bundler.test.ts         # Single test file, parameterized over all bundlers
```

Every fixture has:
- **`wrangler.jsonc`** — single source of truth for config (`main`, `compatibility_date`, `compatibility_flags`, `rules`, bindings, etc.)
- **`src/`** — the worker source code
- **`assertions.ts`** — exports an array of `(path, expectedResponse)` pairs for HTTP assertions
- Any additional asset files (`.wasm`, `.bin`, `.txt`, etc.)

### Harness Flow

For each fixture × each bundler implementation:

1. **Read `wrangler.jsonc`** — parse to get entry point, compat flags, module rules, bindings
2. **Bundle** — one of three ways:
   - **Wrangler (oracle)**: run `wrangler deploy --dry-run --outdir <tmp>` → scan the output directory → normalize to our `BuildResult` format
   - **Esbuild Layer**: convert `wrangler.jsonc` to `BundleConfig` → `Bundler.bundle(config).pipe(Effect.provide(EsbuildBundler), Effect.runPromise)`
   - **Rolldown Layer**: same config → `Bundler.bundle(config).pipe(Effect.provide(RolldownBundler), Effect.runPromise)`
3. **Run in Miniflare** — load the `BuildResult` (entry JS + additional modules), plus Miniflare config derived from `wrangler.jsonc` (compat date, compat flags, bindings)
4. **Assert** — run the fixture's assertion list (HTTP request path → expected response)

If all three bundlers produce the same runtime behavior, we're correct. If Wrangler passes but we fail, it's our bug.

```ts
// test/harness.ts
import { Miniflare } from "miniflare";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

// Our canonical output format
interface BuildResult {
  entryPoint: string;
  code: string | Uint8Array;
  sourceMap?: string;
  additionalModules: Array<{
    name: string;
    type: "ESModule" | "CommonJS" | "Text" | "Data" | "CompiledWasm";
    content: string | Uint8Array;
  }>;
}

// Read wrangler.jsonc and derive Miniflare config
export function readFixtureConfig(fixturePath: string) {
  const raw = readFileSync(join(fixturePath, "wrangler.jsonc"), "utf-8");
  const config = JSON.parse(stripJsonComments(raw));
  return {
    config,
    miniflareOptions: {
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags ?? [],
      // Derive bindings from wrangler.jsonc as needed
    },
  };
}

// Normalize Wrangler's --dry-run --outdir output into BuildResult
export function loadWranglerOutput(outdir: string, entryName: string): BuildResult {
  const files = readdirSync(outdir);
  const entryFile = files.find(f => f.endsWith(".js") && !f.endsWith(".map"));
  const code = readFileSync(join(outdir, entryFile!));
  const additionalModules = files
    .filter(f => f !== entryFile && f !== "README.md" && !f.endsWith(".map"))
    .map(f => ({
      name: f,
      type: inferModuleType(extname(f)),
      content: readFileSync(join(outdir, f)),
    }));
  return { entryPoint: entryFile!, code, additionalModules };
}

function inferModuleType(ext: string) {
  switch (ext) {
    case ".wasm": return "CompiledWasm" as const;
    case ".txt": case ".html": case ".sql": return "Text" as const;
    case ".bin": return "Data" as const;
    default: return "ESModule" as const;
  }
}

// Load BuildResult into Miniflare
export async function runWorker(result: BuildResult, miniflareOptions: object) {
  return new Miniflare({
    modules: [
      { type: "ESModule", path: result.entryPoint, contents: result.code },
      ...result.additionalModules.map(m => ({
        type: m.type, path: m.name, contents: m.content,
      })),
    ],
    ...miniflareOptions,
  });
}

export async function fetchJson(mf: Miniflare, path: string) {
  const res = await mf.dispatchFetch(`http://localhost${path}`);
  return res.json();
}

export async function fetchText(mf: Miniflare, path: string) {
  const res = await mf.dispatchFetch(`http://localhost${path}`);
  return res.text();
}

// Bundle with Wrangler as the correctness oracle
export function bundleWithWrangler(fixturePath: string): BuildResult {
  const tmpDir = join(fixturePath, ".tmp-wrangler-out");
  execSync(`wrangler deploy --dry-run --outdir ${tmpDir}`, { cwd: fixturePath });
  const config = readFixtureConfig(fixturePath);
  return loadWranglerOutput(tmpDir, config.config.main);
}
```

### Parameterized Test Pattern

All tests run the same assertions for every bundler, including Wrangler as baseline:

```ts
// test/bundler.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { Effect } from "effect";
import { Bundler } from "../src/index.js";
import { EsbuildBundler } from "../src/esbuild.js";
import { RolldownBundler } from "../src/rolldown.js";
import {
  readFixtureConfig, runWorker, fetchJson, fetchText, bundleWithWrangler,
} from "./harness.js";

// Each fixture exports its assertions
import { assertions as additionalModulesAssertions } from "./fixtures/additional-modules/assertions.js";

const bundlers = [
  ["wrangler", null],             // oracle — uses bundleWithWrangler()
  ["esbuild", EsbuildBundler],
  ["rolldown", RolldownBundler],
] as const;

describe.each(bundlers)("additional-modules (%s)", (name, BundlerLayer) => {
  let mf: Miniflare;

  afterEach(async () => { await mf?.dispose(); });

  it("produces correct runtime behavior", async () => {
    const fixturePath = "./fixtures/additional-modules";
    const { config, miniflareOptions } = readFixtureConfig(fixturePath);

    // Bundle with the appropriate strategy
    const result = BundlerLayer
      ? await Bundler.bundle(config).pipe(Effect.provide(BundlerLayer), Effect.runPromise)
      : bundleWithWrangler(fixturePath);

    mf = await runWorker(result, miniflareOptions);

    // Run all assertions from the fixture
    for (const { path, expected, mode } of additionalModulesAssertions) {
      const actual = mode === "json"
        ? await fetchJson(mf, path)
        : await fetchText(mf, path);
      expect(actual).toEqual(expected);
    }
  });
});
```

### Fixture Assertions Format

```ts
// test/fixtures/additional-modules/assertions.ts
export const assertions = [
  { path: "/bin",  mode: "json", expected: { byteLength: 342936 } },
  { path: "/text", mode: "text", expected: "Example text content.\n" },
  { path: "/sql",  mode: "text", expected: "SELECT * FROM users;\n" },
  { path: "/wasm", mode: "json", expected: { result: 7 } },
  { path: "/wasm-with-module-param", mode: "json", expected: { result: 11 } },
  { path: "/wasm-with-init-param",  mode: "json", expected: { result: 15 } },
] as const;
```

### Why Wrangler as Oracle

Most Wrangler tests **don't actually run workers** — they mock the Workers API and assert on upload payloads (modules, bindings, metadata). This means they can pass even if the output wouldn't work at runtime. By contrast, our harness always runs the bundled code in Miniflare. Using Wrangler's actual bundling output as a baseline ensures we're testing against known-good behavior, not our own assumptions.

### Wrangler Output Normalization

`wrangler deploy --dry-run --outdir <dir>` produces:
- `index.js` — the bundled entry
- `index.js.map` — source map (if `upload_source_maps` is enabled)
- Additional modules with SHA1-hashed filenames (e.g., `0a0a9f...textfile.txt`, `d025a0...hello.wasm`)
- `README.md` — ignorable

The harness normalizes this by scanning the output dir, inferring module types from file extensions (`.wasm` → CompiledWasm, `.txt`/`.html`/`.sql` → Text, `.bin` → Data), and constructing a `BuildResult`. The SHA1 prefixes don't matter — Miniflare only cares about the module type and content.

---

## 2. Wrangler Test Catalog

### 2.1 In-Scope: Bundling Behavior Tests

#### `find-additional-modules.test.ts`
**What it tests:** Filesystem discovery of non-JS modules using glob-based module rules.

| Scenario | Relevance | Notes |
|----------|-----------|-------|
| JS files with module rules → ESM/CJS | ⚠️ Low | We resolve via plugin hooks, not filesystem scan |
| Glob pattern matching | ⚠️ Low | Same — our plugins see imports directly |
| Exclusion of `.wrangler/` dirs | ⚠️ Low | Wrangler-specific concern |
| Python module discovery | ❌ Out of scope | Python Workers not supported |
| Default module rules (txt/html/sql) | ✅ Port | Rule defaults are relevant for our Additional Modules plugin |

**Verdict:** Port only the default module rules assertions. The filesystem scan approach itself is not relevant — we handle modules through bundler plugin hooks.

#### `navigator-user-agent.test.ts`
**What it tests:** The `defineNavigatorUserAgent` define behavior based on compat dates/flags.

| Scenario | Relevance | Notes |
|----------|-----------|-------|
| Date-based navigator define | ✅ Port | Our Defines plugin needs this |
| Flag override (`global_navigator` / `no_global_navigator`) | ✅ Port | Same |
| Conflicting flags → error | ✅ Port | Same |
| Tree-shaking of navigator.userAgent | ✅ Port | Verify define produces correct dead-code elimination |

**Verdict:** Port fully. This maps directly to our Defines plugin.

#### `guess-worker-format.test.ts`
**What it tests:** Detecting ESM vs service-worker format via a lightweight esbuild scan.

| Scenario | Relevance | Notes |
|----------|-----------|-------|
| `export default` → modules format | ❌ Skip | We're ESM-only |
| No exports → service-worker | ❌ Skip | We're ESM-only |
| Warning on named exports without default | ⚠️ Maybe | Could port as a warning/lint |

**Verdict:** Skip. We only support ESM format. A validation that the entry has a default export could be useful but is not a priority.

#### `get-entry.test.ts`
**What it tests:** Entry point resolution (finding the right file from config).

| Scenario | Relevance | Notes |
|----------|-----------|-------|
| Resolving `main` from config | ✅ Port | Basic entry resolution |
| TypeScript entry transpilation | ✅ Port | Implicit in bundler behavior |
| Relative path resolution | ✅ Port | Important for correctness |

**Verdict:** Port the core resolution scenarios. The resolution logic itself is simple, but tests ensure we don't regress.

#### `deploy/build.test.ts`
**What it tests:** Build configuration options passed through to the bundler.

| Scenario | Relevance | Notes |
|----------|-----------|-------|
| `define` replacements | ✅ Port | Core Defines plugin functionality |
| Environment-specific define overrides | ❌ Skip | Wrangler config concern |
| CLI `--define` overrides | ❌ Skip | Wrangler CLI concern |
| Custom build commands (`build.command`) | ❌ Skip | Wrangler feature |
| Minification | ✅ Port | Bundler config option |
| `nodejs_compat` flag behavior | ✅ Port | Core Node.js Compat plugin |
| Node builtins → helpful warnings | ✅ Port | Node.js Compat plugin warnings |
| Source maps | ✅ Port | BuildResult should include source maps |
| `--no-bundle` mode | ❌ Skip | Wrangler-specific escape hatch |
| Bundle size diagnostics | ❌ Skip | Wrangler CLI output |

**Verdict:** Port define, minification, nodejs_compat, source map, and warning tests. Skip CLI and Wrangler-config-specific tests.

#### `deploy/formats.test.ts`
**What it tests:** Module upload rules and format-specific behavior.

| Scenario | Relevance | Notes |
|----------|-----------|-------|
| Text module rules → correct type annotation | ✅ Port | Additional Modules plugin |
| ESModule rules → relative imports | ✅ Port | Additional Modules plugin |
| `fallthrough` behavior | ✅ Port | Module rule resolution |
| `preserve_file_names` | ✅ Port | Output naming |
| `process.env.NODE_ENV` injection | ✅ Port | Defines plugin |
| Service worker format errors | ❌ Skip | ESM-only |
| Legacy module specifier deprecation | ❌ Skip | Wrangler compat concern |

**Verdict:** Port module rule matching and `process.env.NODE_ENV` tests. Skip service-worker format tests.

#### `deploy/entry-points.test.ts`
**What it tests:** Entry point resolution and module type handling.

| Scenario | Relevance | Notes |
|----------|-----------|-------|
| TypeScript transpilation | ✅ Port | Basic bundler functionality |
| Text module imports | ✅ Port | Additional Modules plugin |
| `cloudflare:*` external imports | ✅ Port | Cloudflare Externals plugin |
| Site config deprecation | ❌ Skip | Wrangler feature |

**Verdict:** Port module import and external tests. Skip Wrangler-specific config tests.

### 2.2 In-Scope: Fixtures to Port

Wrangler tests largely create fixtures inline (via `writeFile` / `writeWorkerSource` in tests), but several useful fixture patterns exist:

| Fixture Pattern | Source | What to Port |
|----------------|--------|--------------|
| Worker with `.wasm` import | Inline in formats.test.ts | WASM import + execution |
| Worker with `.txt`/`.html`/`.sql` imports | Inline in formats.test.ts | Text module imports |
| Worker with `.bin` import | Inline in formats.test.ts | Data module imports |
| Worker with `cloudflare:*` imports | Inline in entry-points.test.ts | External resolution |
| Worker with `node:*` imports + compat | Inline in build.test.ts | Node polyfill resolution |
| Basic TypeScript worker | Inline | Entry resolution + transpilation |

### 2.3 Out of Scope

| Test / Feature | Reason |
|---------------|--------|
| `pages/` tests | Pages not supported |
| `d1/` tests | D1 CLI/migration concerns |
| `kv/` tests | KV CLI concerns |
| `r2/` tests | R2 CLI concerns |
| `dev.test.ts` | Dev server (Wrangler feature) |
| `publish.test.ts` / `deploy.test.ts` | Deployment (not bundling) |
| `tail.test.ts`, `secret.test.ts`, etc. | Runtime management |
| `init.test.ts` | Project scaffolding |
| Service worker format tests | ESM-only |
| Python module tests | Not supported |
| Custom build command tests | Wrangler feature |
| `--no-bundle` tests | Wrangler escape hatch |

---

## 3. Vite Plugin Test Catalog

The Vite plugin's playground tests are the closest analog to our target test pattern: they build workers, serve them (via Miniflare), and make HTTP assertions.

### 3.1 In-Scope: Playground Tests to Port

#### `module-resolution`
**What it tests:** Import resolution for various module formats and sources.

| Test | HTTP Request | Expected Response | Relevance |
|------|-------------|-------------------|-----------|
| require with extensions | `/require-ext` | Module resolution results | ✅ Port |
| require without extensions | `/require-no-ext` | Auto-resolution results | ✅ Port |
| require JSON | `/require-json` | Package metadata | ✅ Port |
| `cloudflare:*` imports | `/cloudflare-imports` | Class instances | ✅ Port |
| External `cloudflare:*` imports | `/external-cloudflare-imports` | Transitive externals | ✅ Port |
| Third-party packages (React, Remix, etc.) | `/third-party/*` | Package outputs | ✅ Port |
| User aliases | `/@alias/test` | Alias resolution | ⚠️ Low priority |
| optimizeDeps.exclude | `/optimize-deps/exclude` | Vite-specific | ❌ Skip |

**Verdict:** Port most tests. Skip Vite-specific `optimizeDeps` tests. Alias resolution is lower priority but nice to have.

#### `additional-modules`
**What it tests:** Non-JS module imports and their runtime behavior.

| Test | HTTP Request | Expected | Relevance |
|------|-------------|----------|-----------|
| `.bin` data module | `/bin` | `{ byteLength: 342936 }` | ✅ Port |
| `.html` text module | `/html` | `<h1>Hello world</h1>` | ✅ Port |
| `.txt` text module | `/text` | "Example text content.\n" | ✅ Port |
| `.sql` text module | `/sql` | "SELECT * FROM users;\n" | ✅ Port |
| `.wasm` compiled module | `/wasm` | `{ result: 7 }` | ✅ Port |
| `.wasm?module` query | `/wasm-with-module-param` | `{ result: 11 }` | ✅ Port |
| `.wasm?init` query | `/wasm-with-init-param` | `{ result: 15 }` | ✅ Port |

**Verdict:** Port all. This is a critical test suite — directly validates our Additional Modules plugin.

#### `node-compat` (12 variants)
**What it tests:** Node.js polyfill behavior via `unenv` + `@cloudflare/unenv-preset`.

| Variant | What it validates | Relevance |
|---------|------------------|-----------|
| `worker-basic` | Basic Node.js compat flag works | ✅ Port |
| `worker-process` | Global `process` object | ✅ Port |
| `worker-crypto` | X509Certificate, crypto APIs | ✅ Port |
| `worker-random` | Math.random (not strictly Node) | ⚠️ Low |
| `worker-https` | HTTPS/TLS module | ✅ Port |
| `worker-debug` | Debug module | ✅ Port |
| `worker-als` | AsyncLocalStorage | ✅ Port |
| `worker-cross-env` | Cross-env compat | ✅ Port |
| `worker-postgres` | pg driver compat | ✅ Port (stretch) |
| `worker-resolve-externals` | External resolution | ✅ Port |
| Other variants | Various Node API coverage | ✅ Port |

**Verdict:** Port all. These directly validate our Node.js Compat plugin. They're simple (fetch `/` → expect `"OK!"`) and high-value.

#### `node-env`
**What it tests:** `process.env.NODE_ENV` replacement and tree-shaking.

| Test | What it validates | Relevance |
|------|------------------|-----------|
| NODE_ENV = "production" in build | Define replacement works | ✅ Port |
| React dev code tree-shaken | Dead code eliminated | ✅ Port |

**Verdict:** Port. Validates our Defines plugin with a real-world tree-shaking scenario.

#### `dynamic-import-paths`
**What it tests:** Dynamic imports with variable paths resolve in builds.

| Test | What it validates | Relevance |
|------|------------------|-----------|
| Static + dynamic path imports | Both resolve identically | ✅ Port |

**Verdict:** Port. Build-only test but validates an important bundler behavior.

#### `virtual-modules`
**What it tests:** Virtual module support in Vite config.

| Test | What it validates | Relevance |
|------|------------------|-----------|
| Virtual module import | `"virtual module"` response | ⚠️ Low |

**Verdict:** Low priority. Virtual modules are more of a Vite concern. However, if users want custom virtual modules in their bundler config, this could matter.

#### `durable-objects`
**What it tests:** Durable Object class detection and state persistence.

| Test | What it validates | Relevance |
|------|------------------|-----------|
| Legacy DO (no class extension) | Export detection | ⚠️ Maybe |
| Modern DO (extends DurableObject) | Class export + state | ⚠️ Maybe |

**Verdict:** Lower priority for bundling specifically. DO detection is more about the deployment config than bundling. However, ensuring DO classes survive bundling (not tree-shaken) is worth testing.

#### `multi-worker`
**What it tests:** Multiple workers in one project, service bindings, RPC.

| Test | What it validates | Relevance |
|------|------------------|-----------|
| Separate output directories | Build orchestration | ❌ Skip (orchestration) |
| Service bindings / RPC | Runtime feature | ❌ Skip (not bundling) |
| Basic worker response | Worker runs | ✅ Port (basic case) |

**Verdict:** Skip most. Multi-worker orchestration and service bindings are deployment concerns. The basic "worker responds correctly" case is already covered by simpler fixtures.

### 3.2 Out of Scope

| Playground / Test | Reason |
|-------------------|--------|
| `pages-*` playgrounds | Cloudflare Pages not supported |
| `assets-only` | Assets (not bundling) |
| `external-durable-objects` | Deployment topology |
| `multi-worker` RPC tests | Service binding runtime |
| `static-assets-*` | Assets serving |
| `spa-*` | SPA routing (Pages/assets) |
| `wrangler-*` playgrounds | Wrangler integration |
| `react-router-*` | Framework integration |
| E2E tests (`e2e/`) | Full Vite project scaffolding |
| Config unit tests (`src/__tests__/`) | Vite plugin config parsing |

---

## 4. Priority-Ordered Test Implementation Plan

### Phase 1: Core Plugin Tests (Critical Path)

These tests validate the four unplugin plugins and should be implemented first.

| Test Suite | Source | Plugin Validated | Fixture Complexity |
|-----------|--------|-----------------|-------------------|
| Cloudflare externals | Wrangler entry-points + Vite module-resolution | `cloudflare-externals` | Simple |
| `process.env.NODE_ENV` | Wrangler build + Vite node-env | `defines` | Simple |
| Navigator define | Wrangler navigator-user-agent | `defines` | Simple |
| Text modules (.txt, .html, .sql) | Vite additional-modules | `additional-modules` | Simple |
| Data modules (.bin) | Vite additional-modules | `additional-modules` | Simple |
| WASM modules (.wasm) | Vite additional-modules | `additional-modules` | Medium |
| WASM ?module / ?init | Vite additional-modules | `additional-modules` | Medium |
| Basic Node.js compat | Vite node-compat/worker-basic | `nodejs-compat` | Medium |
| Node.js process global | Vite node-compat/worker-process | `nodejs-compat` | Medium |
| Node.js crypto APIs | Vite node-compat/worker-crypto | `nodejs-compat` | Medium |

### Phase 2: Extended Coverage

| Test Suite | Source | What it validates |
|-----------|--------|------------------|
| Module rules (fallthrough, types) | Wrangler formats | Additional Modules rule matching |
| All node-compat variants | Vite node-compat/* | Full polyfill coverage |
| Third-party package resolution | Vite module-resolution | Complex dependency graphs |
| Dynamic import paths | Vite dynamic-import-paths | Bundler chunk splitting |
| React tree-shaking | Vite node-env | Dead code elimination with defines |
| Source map generation | Wrangler build | BuildResult source maps |
| Minification | Wrangler build | Config passthrough |
| `preserve_file_names` | Wrangler formats | Output naming |
| TypeScript entry | Wrangler entry-points | Transpilation |

### Phase 3: Benchmarks

| Benchmark | What to measure |
|-----------|----------------|
| Simple worker (no deps) | Baseline bundle time |
| Worker with node-compat | Polyfill resolution overhead |
| Worker with many additional modules | Module collection overhead |
| Large dependency tree (e.g., React SSR) | Real-world performance |

Each benchmark should compare esbuild vs rolldown and report:
- Bundle time (cold + warm)
- Output size
- Memory usage

---

## 5. Fixture Inventory

Each fixture is a self-contained worker project with a `wrangler.jsonc`, source code, and an `assertions.ts` file defining expected HTTP behavior.

### Fixture Structure

```
test/fixtures/
├── basic-worker/
│   ├── wrangler.jsonc              # { "name": "basic", "main": "./src/index.ts", "compatibility_date": "2024-12-30" }
│   ├── src/index.ts                # export default { fetch() { return new Response("ok") } }
│   └── assertions.ts              # [{ path: "/", mode: "text", expected: "ok" }]
├── cloudflare-externals/
│   ├── wrangler.jsonc
│   ├── src/index.ts                # imports from cloudflare:workers, cloudflare:sockets
│   └── assertions.ts
├── defines/
│   ├── wrangler.jsonc              # includes define: { "MY_VAR": "\"replaced\"" }
│   ├── src/index.ts                # uses process.env.NODE_ENV + navigator.userAgent
│   └── assertions.ts
├── additional-modules/
│   ├── wrangler.jsonc
│   ├── src/index.ts                # imports all module types, routes by path
│   ├── data.bin                    # binary data file
│   ├── page.html                   # HTML text module
│   ├── content.txt                 # plain text module
│   ├── query.sql                   # SQL text module
│   ├── add.wasm                    # simple add(a, b) WASM function
│   ├── multiply.wasm              # for ?module / ?init variants
│   └── assertions.ts
├── node-compat/
│   ├── basic/
│   │   ├── wrangler.jsonc          # has nodejs_compat_v2 in compatibility_flags
│   │   ├── src/index.ts
│   │   └── assertions.ts
│   ├── crypto/
│   │   ├── wrangler.jsonc
│   │   ├── src/index.ts            # node:crypto usage
│   │   └── assertions.ts
│   ├── process/
│   │   ├── wrangler.jsonc
│   │   ├── src/index.ts            # process global
│   │   └── assertions.ts
│   ├── async-local-storage/
│   │   ├── wrangler.jsonc
│   │   ├── src/index.ts            # node:async_hooks ALS
│   │   └── assertions.ts
│   └── ...                         # other variants as needed
├── module-resolution/
│   ├── wrangler.jsonc
│   ├── src/index.ts                # various import styles, routes by path
│   ├── src/require-target.js
│   ├── src/require-target.cjs
│   ├── src/data.json
│   └── assertions.ts
├── dynamic-imports/
│   ├── wrangler.jsonc
│   ├── src/index.ts                # dynamic import() with variable path
│   ├── src/chunks/data.ts
│   └── assertions.ts
└── tree-shaking/
    ├── wrangler.jsonc
    ├── src/index.tsx               # React SSR with NODE_ENV-dependent code
    ├── package.json                # depends on react, react-dom
    └── assertions.ts
```

### Porting WASM Fixtures

The Vite plugin's `additional-modules` playground contains pre-built `.wasm` files (simple add/multiply functions). We should copy these directly rather than building from source — they're stable test artifacts.

### `assertions.ts` Format

Each fixture exports its expected HTTP behavior:

```ts
// test/fixtures/additional-modules/assertions.ts
export const assertions = [
  { path: "/bin",  mode: "json", expected: { byteLength: 342936 } },
  { path: "/html", mode: "html", expected: "<h1>Hello world</h1>" },
  { path: "/text", mode: "text", expected: "Example text content.\n" },
  { path: "/sql",  mode: "text", expected: "SELECT * FROM users;\n" },
  { path: "/wasm", mode: "json", expected: { result: 7 } },
  { path: "/wasm-with-module-param", mode: "json", expected: { result: 11 } },
  { path: "/wasm-with-init-param",  mode: "json", expected: { result: 15 } },
] as const;
```

This decouples assertions from the bundler being tested — the same assertions run for Wrangler, esbuild, and rolldown.

---

## 6. Key Differences from Source Test Suites

| Aspect | Wrangler Tests | Vite Plugin Tests | Our Tests |
|--------|---------------|-------------------|-----------|
| **Test runner** | Vitest + custom `msw` mocking | Vitest + Playwright | Vitest only |
| **Worker execution** | Mock API calls (no real runtime) | Miniflare via Vite preview | Miniflare directly |
| **Bundler invocation** | Via Wrangler CLI simulation | Via Vite build | Via Effect `Bundler.bundle()` |
| **Assertions** | API payload snapshots | HTTP response content | HTTP response content |
| **Multi-bundler** | esbuild only | Rollup/Rolldown only | Both (parameterized) |
| **Fixture creation** | Inline `writeFile` | Checked-in playground dirs | Checked-in fixture dirs |

### Important: Wrangler Tests Don't Actually Run Workers

Most Wrangler deploy tests mock the Workers API and assert on the upload payload (modules, bindings, metadata) — they never actually execute the bundled code. This means they can pass even if the output wouldn't actually work at runtime.

Our tests should always validate runtime behavior by running in Miniflare, following the Vite plugin's pattern. This gives us much stronger correctness guarantees.

---

## 7. Test Infrastructure Requirements

### Dependencies (already in `package.json`)

- `vitest` — test runner
- `miniflare` — local Workers runtime
- `wrangler` — oracle bundler (dev dependency, used via CLI)
- `esbuild` — bundler under test
- `rolldown` — bundler under test
- `effect` — service layer

### Harness Components

| Component | Responsibility |
|-----------|---------------|
| `readFixtureConfig()` | Parse `wrangler.jsonc` → `BundleConfig` + `MiniflareOptions` |
| `bundleWithWrangler()` | Shell out to `wrangler deploy --dry-run --outdir` → `BuildResult` |
| `loadWranglerOutput()` | Scan Wrangler's output dir, infer module types, normalize to `BuildResult` |
| `runWorker()` | Load `BuildResult` into Miniflare with derived config |
| `fetchJson()` / `fetchText()` | HTTP assertion helpers |

### Config-to-Miniflare Mapping

The harness reads `wrangler.jsonc` and derives Miniflare options:

| `wrangler.jsonc` field | Miniflare option |
|------------------------|-----------------|
| `compatibility_date` | `compatibilityDate` |
| `compatibility_flags` | `compatibilityFlags` |
| `durable_objects.bindings` | `durableObjects` |
| `kv_namespaces` | `kvNamespaces` |
| `r2_buckets` | `r2Buckets` |
| `d1_databases` | `d1Databases` |

Most fixtures only need `compatibilityDate` and `compatibilityFlags`. Binding-heavy fixtures can extend as needed.

### Miniflare Configuration Pattern

```ts
const { config, miniflareOptions } = readFixtureConfig(fixturePath);

new Miniflare({
  ...miniflareOptions,
  modules: [
    { type: "ESModule", path: result.entryPoint, contents: result.code },
    ...result.additionalModules.map(m => ({
      type: m.type, path: m.name, contents: m.content,
    })),
  ],
});
```

---

## 8. Summary

| Category | Count | Priority |
|----------|-------|----------|
| **Core plugin tests** (Phase 1) | ~10 fixtures | 🔴 Critical |
| **Extended coverage** (Phase 2) | ~10 fixtures | 🟡 Important |
| **Benchmarks** (Phase 3) | ~4 benchmarks | 🟢 Nice to have |
| **Fixtures to create** | ~10-15 directories | Part of Phase 1-2 |
| **Out of scope** | ~30+ test files | N/A |

### Key Design Decisions

1. **`wrangler.jsonc` as single source of truth** — every fixture is a real worker project with a standard config file. The harness reads this to derive both the `BundleConfig` for our bundler and the `MiniflareOptions` for runtime assertions.

2. **Wrangler as oracle** — `wrangler deploy --dry-run --outdir` produces a known-good bundle. Running the same assertions against Wrangler's output and our output gives us a correctness baseline that's independent of our implementation.

3. **No bundler-specific test directories** — all tests are parameterized over `[wrangler, esbuild, rolldown]`. The whole point of the `Bundler` service abstraction is that runtime behavior is identical regardless of Layer.

4. **Runtime assertions only** — we always run the bundled code in Miniflare and check HTTP responses. No snapshot tests, no AST assertions on the bundle output. If it works in Miniflare, it works.
