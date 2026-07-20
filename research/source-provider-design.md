# Worker SourceProvider — design

Status: design only (no implementation). Target: `packages/alchemy/src/Cloudflare/Workers/*` + framework packages in `cloudflare-tools/`.

## Problem

`WorkerProvider.ts` and `LocalWorkerProvider.ts` each hard-code a per-bundler `if/else` ladder:

- **Deploy** — `prepareAssetsAndBundle` branches on `props.script !== undefined` → `props.vite` → default, and the default arm (`prepareBundle`) branches again on `isPythonMain(props.main)` → `props.bundle === false` → rolldown.
- **Diff** — `hasChanged` re-implements the same ladder with per-arm hash semantics (`hashScript`, `hashViteInput`, `prepareBundle().hash`).
- **Local dev** — `runInstance` branches on `props.vite ? runVite : runWorker`, and `runWorker` branches again on `isPythonMain ? watchPythonWorkerBundle : bundler.watch`.

Adding OpenNext, Astro, SvelteKit, and Waku (each an effectful `{ build, dev }` service in cloudflare-tools, shaped like `cloudflare-tools/packages/tools/e2e/src/Vite.ts`) would mean growing all three ladders in lockstep. Instead we extract the thing each arm actually is — a **source provider**: it supplies (a) the static assets, (b) the server bundle, (c) hashes for memoization, plus a dev-serving story.

## 0. What `putWorker` actually consumes (the contract to preserve)

From `WorkerProvider.ts` (`prepareAssetsAndBundle` → `putWorker`):

```ts
{
  assets: AssetReadResult | undefined,          // Assets.ts readAssets result: { directory, config, manifest, _headers, _redirects, hash }
  bundle: {
    main: string | undefined,                   // entry module name (files[0].path)
    files: File[] | undefined,                  // typed by contentTypeForModule(path)
  },
  hash: {                                       // persisted as Worker["Attributes"]["hash"]
    assets: string | undefined,
    bundle: string | undefined,
    input: string | undefined,                  // vite-only today: source-tree hash
    additionalWorkspaces: string[] | undefined, // vite-only: auto-detected workspace dirs (relative to rootDir)
    metadata?: string,                          // NOT source-related — #745, stays in WorkerProvider
  },
}
```

`putWorker` additionally implements the **AssetsWithHash fast path**: when `props.assets.hash === output.hash.assets` it skips reading the asset directory entirely (`skipAssetsRead`) and sends `keepAssets: true`. That logic is about `props.assets`, not about the source, and stays in `putWorker`.

## 1. The `SourceProvider` interface

### 1.1 Shape

A plain interface of Effects (not a `Context.Service`): providers are *resolved per Worker* from props, not injected once per stack — a stack can host a vite Worker, a python Worker, and an OpenNext Worker simultaneously. The `Context.Service` style of `e2e/src/Vite.ts` is kept for the *framework-side* services (§6); the alchemy-side `SourceProvider` is the adapter over them.

New file `packages/alchemy/src/Cloudflare/Workers/Source.ts`:

```ts
import type * as Bundle from "../../Bundle/Bundle.ts";
import type { AssetReadResult } from "./Assets.ts";

/** The hash slots a source contributes to Worker["Attributes"]["hash"]. */
export interface SourceHash {
  readonly bundle: string | undefined;
  readonly assets: string | undefined;
  readonly input: string | undefined;
  readonly additionalWorkspaces: readonly string[] | undefined;
}

export interface SourceBuildOutput {
  /** Server bundle. `undefined` for assets-only workers (static vite site with no server env). */
  readonly bundle: Bundle.BundleOutput | undefined;   // { files: [entry, ...rest], hash }
  /** Static assets, already read + manifest-hashed. `undefined` when the source has none
   *  (the WorkerProvider still merges in `props.assets` for sources that don't own assets — see 1.4). */
  readonly assets: AssetReadResult | undefined;
  /** Source-owned hash slots. Slots the source doesn't use are `undefined`. */
  readonly hash: SourceHash;
}

/** Everything a source may need, derived once by the WorkerProvider from (id, props, stack). */
export interface SourceContext {
  readonly id: string;                                   // logical id
  readonly workerName: string;                           // physical script name
  readonly compatibility: { date: string; flags: string[] };
  /** Effect-entry vs external-entry (async workers). Drives the virtual-entry plugin. */
  readonly entry:
    | { kind: "external" }
    | { kind: "effect"; exports: Record<string, DurableObjectExport | WorkflowExport> };
  readonly stack: { name: string; stage: string };
  /** Resolved literal env (strings/unwrapped Redacted) — what viteBuild feeds `getDefine` today. */
  readonly env: Record<string, unknown>;
  /** props.build passthrough for rolldown-based sources. */
  readonly extraOptions: Bundle.BundleExtraOptions | undefined;
  /** Asset routing config from props.assets (htmlHandling, notFoundHandling, ...), directory-less. */
  readonly assetsConfig: AssetsConfig | undefined;
  /** True when putWorker's AssetsWithHash fast path already decided assets are unchanged. */
  readonly skipAssetsRead: boolean;
}

export interface SourceProvider {
  /** Full build. Called from reconcile (putWorker). MUST be memoized per run via
   *  Artifacts.cached so a hash() that had to build doesn't build twice. */
  readonly build: (ctx: SourceContext) => Effect.Effect<
    SourceBuildOutput, SourceError, SourceServices
  >;

  /** Recompute the source-owned hash slots for diff, as cheaply as possible and
   *  WITHOUT a full build when the source supports it. `previous` is
   *  `output.hash` from state (needed e.g. by vite's `additionalWorkspaces`).
   *  Returns only the slots this source uses; the WorkerProvider compares
   *  slot-wise against `previous` — any defined slot that differs ⇒ update. */
  readonly hash: (
    ctx: SourceContext,
    previous: SourceHash | undefined,
  ) => Effect.Effect<Partial<SourceHash>, SourceError, SourceServices>;

  /** Local dev. Scoped: closing the Scope stops the watcher / dev server. See §4. */
  readonly dev: (ctx: DevContext) => Effect.Effect<
    SourceDevHandle, SourceError, SourceServices | Scope.Scope
  >;
}
```

### 1.2 Requirements channel (`SourceServices`)

Fixed, small, and satisfiable inside both provider processes:

```ts
type SourceServices =
  | FileSystem.FileSystem
  | Path.Path
  | Artifacts          // per-resource, per-run build cache (already FQN-scoped by the engine)
  | Stack;             // name/stage (already in ctx; kept for helpers like createInternalTags)
```

Anything else a provider needs (vite module loading, uv, `next build`, workerd runtime services for dev) it constructs internally — exactly how `e2e/src/Vite.ts` and today's `viteBuild` already work. External providers must NOT demand bespoke services from the WorkerProvider, or the provider's type signature stops being closed.

### 1.3 Error channel

One closed union, following the Typed Error Doctrine (no `unknown` leaking into lifecycle signatures):

```ts
export class SourceProviderError extends Data.TaggedError("Cloudflare.Workers.SourceProviderError")<{
  readonly provider: string;   // module specifier or built-in kind
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type SourceError =
  | Bundle.BundleError        // rolldown / python / prebuilt (existing)
  | ValidationError           // Assets.ts: AssetTooLarge / TooManyAssets / ... (existing)
  | SourceProviderError;      // everything an external provider raises, wrapped at the load boundary
```

Built-ins keep failing with their existing tags (no test churn). The dynamic-module loader (§3) wraps any foreign error into `SourceProviderError` via `Effect.mapError`, preserving the original as `cause`. This keeps the WorkerProvider's lifecycle error union closed while letting framework packages use their own tagged errors internally.

### 1.4 Division of labor with `putWorker` (unchanged responsibilities)

Stays in `WorkerProvider` (NOT the source):

- `resolveWorkerMetadataHash` / `hash.metadata` (#745) — compared first in diff, computed in putWorker.
- The `AssetsWithHash` keep/skip fast path (`normalizePrebuiltAssets`, `keepAssets`, `skipAssetsRead`) — it's a function of `props.assets` vs `output.hash.assets`.
- **Assets-from-props reading and diffing** for sources that don't own assets (script/rolldown/python/prebuilt): `prepareAssets(props.assets)` and the "no precomputed hash ⇒ assume changed" rule remain central. Sources that DO own assets (vite, all framework sources — assets come out of the build) return them from `build()` and cover them via the `input` hash in `hash()`.
- Asset upload, script upload, DO migrations, domains/routes/crons — all downstream of the source output.

This split is what makes `hash()` clean: each source's `hash()` covers exactly the slots that source computes, and the two diff questions ("did the source change?" / "did the props-level assets change?") stop being interleaved in one `hasChanged` ladder.

## 2. The existing arms as implementations

Built-ins live in `packages/alchemy/src/Cloudflare/Workers/Sources/` (new directory), one file per provider, none exported from the `Cloudflare` barrel (they are engine plumbing, like `BucketBinding.ts` scaffolding):

| Provider | Selected by (today) | `build()` | `hash()` | dev mode (§4) |
| --- | --- | --- | --- | --- |
| `InlineScriptSource` | `props.script` | `bundle = { files: [{path: "main.js", content: script}], hash: sha256(script) }`; no assets | `{ bundle: sha256(script) }` — trivial, never builds | `bundle` — emits a single-element stream (script changes arrive as new props ⇒ instance restart via `structuralSignature`, same as today) |
| `RolldownSource` | default (`props.main`, `bundle !== false`, non-`.py`) | `WorkerBundle.build({ main, compatibility, entry, stack, extraOptions })` under `Artifacts.cached("build")` | **builds** (cached) and returns `{ bundle: out.hash }` — identical to today's `hasChanged` default arm; the Artifacts cache makes diff-then-reconcile build once | `bundle` — `WorkerBundle.watch` stream |
| `PythonSource` | `isPythonMain(props.main)` | `readPythonWorkerBundle` (uv vendoring) under `Artifacts.cached("build")` | builds (cached), `{ bundle }` | `bundle` — `watchPythonWorkerBundle` stream |
| `PrebuiltSource` | `props.bundle === false` | `readPrebuiltWorkerBundle({ main, rules })` (byte-for-byte read + glob) | re-reads and hashes (cheap, no bundling), `{ bundle }` | `bundle` — **new**: fs-watch on the entry directory re-running the read. Fixes an existing bug — see Tensions. |
| `ViteSource` | `props.vite` | current `viteBuild`: run vite builder with `@distilled.cloud/cloudflare-vite-plugin` + `viteBuildOutputPlugin`; `assets = readAssets(clientDirectory + props asset config)`; `bundle = serverBundle`; `input`/`additionalWorkspaces` from `hashViteInput` | `hashViteInput(rootDir, memo, previous.additionalWorkspaces)` → `{ input, additionalWorkspaces }`. Never builds — the #vite fast path today | `server` — current `runVite`: `viteDev` with the worker runtime config, yields the dev-server URL |

Decisions:

- **Python and prebuilt are separate providers, not Rolldown variants.** They share nothing with rolldown but the output type: different build mechanics, different dev stories, different failure modes. `resolveSource` (§3) keeps the selection rules in one place, which is all the "variant" relationship ever was.
- `RolldownSource.hash()` deliberately builds. Recomputing "without building" is impossible for rolldown without a source-tree memo hash, and introducing one silently changes rebuild semantics (gitignore edge cases, node_modules changes). If we later want a memo fast path for plain workers, it's an additive `memo` option on `RolldownSource` that switches its `hash()` to `hashDirectory` — the interface already supports it.
- `ViteSource` keeps storing `hash.bundle` from the built serverBundle even though diff only reads `hash.input` — harmless and useful for debugging; framework sources should follow the same convention (fill every slot you can at build time; diff on the cheapest one).

## 3. Provider selection & the `source:` prop

### 3.1 Constraint: props must stay serializable data

Two hard constraints rule out putting the provider object (closures/Effects) in props:

1. `olds` props are persisted in state and compared across runs.
2. `LocalWorkerProvider` is an **RpcProvider** — props cross a process boundary to the local host (`LOCAL_ENTRY_URL`), and that process does not import the user's `alchemy.run.ts`. A module-level registry populated by user-code imports would be invisible there.

So the `source` prop is a **serializable descriptor**, and the implementation is resolved by **dynamic `import()` of a module specifier** — the same pattern as `main: import.meta.url` and the existing lazy `import("./Vite.ts")` in both providers.

```ts
/** New WorkerProps field. */
export interface WorkerSourceDescriptor {
  /** Module specifier resolved with import(); e.g. "@alchemy.run/cloudflare-next".
   *  The module's default export must satisfy WorkerSourceModule. */
  readonly provider: string;
  /** Provider-specific, JSON-serializable options (rootDir, memo, framework config, ...). */
  readonly options?: unknown;
}

/** The dynamic-module contract. */
export interface WorkerSourceModule {
  readonly make: (options: unknown) => Effect.Effect<SourceProvider, SourceProviderError, SourceServices>;
}
```

The loader (`loadSource(descriptor)`) dynamically imports, validates the shape (fail with `SourceProviderError` naming the specifier), calls `make(options)`, and memoizes per specifier for the process lifetime.

### 3.2 Selection: `resolveSource(props)` — legacy props map to built-ins, non-breaking

```ts
const resolveSource = (props: WorkerProps): Effect<SourceProvider, SourceProviderError | WorkerValidationError, SourceServices> => {
  if (props.source)                  return loadSource(props.source);   // new prop wins
  if (props.script !== undefined)    return InlineScriptSource;
  if (props.vite)                    return ViteSource;                 // lazy import("./Sources/Vite.ts")
  if (isPythonMain(props.main))      return PythonSource;
  if (props.bundle === false)        return PrebuiltSource;
  /* props.main */                   return RolldownSource;
};
```

- **No breaking change**: `script` / `vite` / `main` / `bundle: false` / `.py` keep working exactly as today; they simply resolve to built-in providers. The built-ins are NOT re-expressed as `source:` descriptors in props (that would churn persisted `olds` and the local `structuralSignature`); `source:` is only for external providers.
- **Mutual exclusion** is validated in `resolveSource`: `source` combined with `script`/`vite`/`main` is a `WorkerValidationError` (a source is self-contained; a framework source that needs a custom entry takes it in its own `options`, like `ViteOptions.main` does today).
- A discriminated union in `WorkerProps` (`source: { kind: "vite" | "python" | ... }`) was considered and rejected: it forces a breaking rewrite of every existing call site and of `Website.Vite`/`StaticSite`, for zero capability gain. The descriptor + legacy mapping gets the same dispatch table without migration.
- `Website.Vite` continues to set `props.vite` (`@internal`) unchanged in step 1; it can migrate to a `source` descriptor for the built-in later if we ever want to delete the `vite` prop — documented as a possible follow-up, not part of this refactor.

## 4. The `dev()` story

### 4.1 What LocalWorkerProvider passes today

- **Plain/python workers** (`runWorker`): builds a `WorkerConfig` (name, compatibility, runtime `BindingHook`s, DO namespaces incl. containers, hyperdrives, `bundleOptions`, assets, dev port), starts a `WorkerProxy`, subscribes to `bundler.watch` / `watchPythonWorkerBundle`'s `Stream<BundleWatchEvent>`, and on each `Success` restarts workerd (`runtime.start` with `modules` + `assets` + bindings) behind the proxy. Restart-on-wiring-change (queue consumers) is handled by `latestServes` + `localRuntimeState.workerRestarts`.
- **Vite workers** (`runVite`): starts the proxy, then `viteDev(rootDir, env, { main, compat, viteEnvironments, worker: { name, bindings, durableObjectNamespaces, hyperdrives, queueConsumers, assets }, context }, { port: 0 })` and points the proxy at the vite dev server URL. The vite plugin hosts its own workerd.

Two irreducible modes: "host runs workerd, source streams bundles" vs "source runs its own server". The unified contract is a discriminated handle:

```ts
export interface DevContext extends SourceContext {
  /** Runtime wiring for server-mode providers that embed their own workerd
   *  (the exact object runVite hands to the vite plugin today). */
  readonly worker: {
    readonly name: string;
    readonly bindings: BindingHook<BindingServices>[];
    readonly durableObjectNamespaces: (RuntimeDurableObject & { uniqueKey: string })[];
    readonly hyperdrives: Record<string, Required<HyperdriveOrigin>>;
    readonly queueConsumers: Effect.Effect<RuntimeQueueConsumer[]>; // re-read on (re)start
    readonly assets: RuntimeAssets | undefined;
  };
  /** RuntimeServices context for cloudflare-runtime-embedding providers. */
  readonly runtimeContext: Context.Context<RuntimeServices>;
}

export type SourceDevHandle =
  | {
      /** Host runs workerd. Source supplies rebuild events; assets served from `ctx.worker.assets`. */
      readonly mode: "bundle";
      readonly bundles: Stream.Stream<Bundle.BundleWatchEvent>;
    }
  | {
      /** Source serves itself (vite dev, next dev). Host points the WorkerProxy at `url`. */
      readonly mode: "server";
      readonly url: URL;
      /** Optional: restart hook so queue-consumer wiring changes propagate (see Tensions). */
      readonly restart?: Effect.Effect<void>;
    };
```

`LocalWorkerProvider.runInstance` becomes:

```ts
const handle = yield* source.dev(devCtx);           // scoped to the instance scope
switch (handle.mode) {
  case "bundle": return yield* runWorker(config, handle.bundles);  // existing stream-drain + serveWith machinery, minus the python/rolldown branch
  case "server": yield* proxy.set(handle.url); return proxy.url;
}
```

The `WorkerProxy` + `latestServes`/restart/`serveLock` machinery stays in `LocalWorkerProvider` — it is per-instance orchestration, not source behavior. The source only answers "how do I get fresh runnable output".

Framework fit: Astro/SvelteKit/Waku dev are vite `createServer` under the hood (per the research specs) → `server` mode reusing the identical `worker` wiring the vite plugin already accepts. OpenNext dev is `next dev` + a bindings proxy → also `server` mode (its provider internally runs next dev and a `cloudflare-runtime`-backed binding bridge fed from `ctx.worker`).

## 5. The diff / `hash()` story

Diff flow in `WorkerProvider.diff` after the refactor (semantics-preserving):

```
1. structural props checks (name/namespace/account → replace)  [unchanged]
2. domains / routes / crons diff                                [unchanged]
3. metadata hash (#745): resolveWorkerMetadataHash vs output.hash.metadata  [unchanged, still first]
4. props-level assets diff (only when the source doesn't own assets):
     AssetsWithHash → compare props.assets.hash vs output.hash.assets
     legacy string/AssetsProps → assume changed (putWorker keepAssets recovers)  [unchanged]
5. source diff: slots = yield* source.hash(ctx, output.hash)
     changed ⇔ ∃ defined slot k: slots[k] !== output.hash[k]
```

Exact per-provider semantics ("recompute without building" per source):

| Provider | `hash()` computes | Rebuild-free? | Matches today's `hasChanged` arm |
| --- | --- | --- | --- |
| InlineScript | `bundle = sha256(props.script)` | yes | `hashScript` compare |
| Rolldown | `bundle` via full build under `Artifacts.cached("build")` | no — but the build is reused by `reconcile` in the same run (Artifacts is FQN-scoped per resource per run) | `prepareBundle(...).hash` compare |
| Python | `bundle` via `readPythonWorkerBundle` (cached) | no (uv vendor + read; cached) | same default arm |
| Prebuilt | `bundle` via re-read + hash of on-disk modules | yes (no bundling; just IO + sha256) | same default arm |
| Vite | `input` (+ `additionalWorkspaces`) via `hashViteInput(rootDir, memo, previous.additionalWorkspaces)` | **yes** — this is the whole point of the input hash | `hashViteInput` compare vs `output.hash.input` |
| OpenNext/Astro/SvelteKit/Waku | `input` via `hashDirectory` over the project root (+ memo options + lockfile), same recipe as vite | yes | n/a (new) |

Invariants (write these into the `SourceProvider.hash` JSDoc):

- `hash()` MUST be deterministic for an unchanged source tree and machine-independent for identical bytes (the same rule `readAssets` and `hashViteInput` already follow — never hash absolute paths).
- If `hash()` cannot avoid building, it MUST route the build through the same `Artifacts.cached` key as `build()` so diff→reconcile builds once.
- `previous` is a hint, never truth: a provider must not skip recomputation because `previous` looks fresh (state can be stale/foreign) — it may only use `previous` for auxiliary inputs (`additionalWorkspaces`).
- The #745 metadata-hash fast path is untouched: it runs before `source.hash()` and catches every non-source deploy-surface edit; `hash.metadata` is never a source slot.

## 6. Plugging in framework providers

### 6.1 Package layout

Heavy lifting lives in cloudflare-tools; alchemy gets a thin, typed wrapper per framework:

```
cloudflare-tools/packages/next/           @alchemy.run/cloudflare-next      (OpenNext-based; per opennextjs-cloudflare.md)
cloudflare-tools/packages/astro/          @alchemy.run/cloudflare-astro
cloudflare-tools/packages/sveltekit/      @alchemy.run/cloudflare-sveltekit (custom adapter per sveltekit.md)
cloudflare-tools/packages/waku/           @alchemy.run/cloudflare-waku
```

Each package:

- keeps its internal `Context.Service` shape (`{ build, dev }` like `e2e/src/Vite.ts`) for standalone use and e2e fixtures;
- exports a **default `WorkerSourceModule`** (`{ make(options) }`) adapting that service to `SourceProvider`. `make` provides the package's own layers internally (`Effect.provide`), so the closed `SourceServices` requirement holds;
- depends on `alchemy` only as a **peer/dev dependency for types** (`SourceProvider`, `SourceContext`, `Bundle.BundleOutput`, `AssetReadResult` are all exported from `alchemy/Cloudflare`). The contract is structural, so version skew degrades to a load-time `SourceProviderError`, not a crash.

### 6.2 Alchemy-side wrappers

User-facing sugar lives in `packages/alchemy/src/Cloudflare/Website/` — the established home for "a Worker built from a web project" (`Vite.ts`, `StaticSite.ts` are the precedent; `Workers/Sources/` is engine plumbing, not user API):

```ts
// packages/alchemy/src/Cloudflare/Website/Next.ts
export const Next = (id: string, props?: NextProps) =>
  Worker(id, {
    ...props,
    source: {
      provider: "@alchemy.run/cloudflare-next",
      options: { rootDir: props?.rootDir, memo: props?.memo, ...props?.next },
    },
  });
```

Same class-form / bindings typing treatment as `Website.Vite` (its `NormalizedBindings<..., WorkerAssetsConfig>` pattern is reused verbatim). The wrapper is ~50 lines + JSDoc; the framework package never imports the Worker resource.

The dynamic-import specifier means the framework package must be installed in the user's project — the wrapper's JSDoc documents this, and `loadSource`'s import-failure error message names the package to install (mirroring how `runUv` reports a missing `uv`).

### 6.3 What a framework `build()` returns

Per the research specs, all four frameworks converge on the vite-shaped output: `clientDirectory` → `readAssets(...)` → `assets`; server modules (entry first) → `Bundle.BundleOutput`; project-tree hash → `input`. OpenNext's `.open-next/worker.js` output is prebuilt-flavored (its provider runs the OpenNext build, then finishes the bundling wrangler would have done — per the spec — and reads the result like `PrebuiltSource`). Either way it fits `SourceBuildOutput` with no new slots.

## 7. Refactor plan (each step type-checks and tests green)

1. **Extract types + built-ins, dispatch deploy path.** Add `Workers/Source.ts` (types) and `Workers/Sources/{InlineScript,Rolldown,Python,Prebuilt,Vite}.ts` by *moving* the bodies of `prepareBundle`, `viteBuild`, `hashViteInput`, `hashScript` out of `WorkerProvider.ts`. Rewrite `prepareAssetsAndBundle` and `hasChanged` as `resolveSource(props)` + `source.build/hash` (legacy mapping only; no `source` prop yet). Vite source keeps the lazy `import()` so the plugin's module cost stays off the hot path. `bun tsc -b`; run: `test/Cloudflare/Workers/{Worker,WorkerProvider,PrebuiltWorker,PrebuiltWorkerBundle,PythonWorker,WorkerCache}.test.ts`, `test/Cloudflare/Website/{Vite,StaticSite}.test.ts`.
2. **Dispatch local dev.** Add `dev()` to the five built-ins; rewrite `LocalWorkerProvider.runInstance` on `SourceDevHandle` (`runWorker` keeps the serve/restart machinery, loses its python branch; `runVite` body moves into `ViteSource.dev`). Give `PrebuiltSource` a real fs-watch dev (bug fix, see Tensions). Run: `test/Cloudflare/Workers/{PythonWorkerLocal,RandomEnvLocal,BrowserLocal,InitIO}.test.ts` plus the Website dev-mode cases (`tanstack-dev-bindings-fixture` via `Vite.test.ts`, `StaticSite.test.ts` dev case).
3. **Add the `source:` prop + loader.** `WorkerSourceDescriptor` on `WorkerProps`, `loadSource` with validation + `SourceProviderError`, mutual-exclusion checks, and the metadata-hash contribution (`props.source` descriptor participates in `resolveWorkerMetadataHash`'s input so switching providers triggers an update). Unit-test the loader with a local fixture module (no cloud needed).
4. **First framework provider** (recommend **Waku** first — smallest gap per `waku.md`, pure vite topology already exercised by the react-router-rsc fixture; OpenNext second since it needs the wrangler-replacement bundling pass). Package in cloudflare-tools + `Website.Waku` wrapper + a deploy/dev test mirroring `Website/Vite.test.ts` structure.
5. **Docs.** JSDoc on the new wrappers + `bun generate:api-reference`.

Steps 1 and 2 are pure refactors guarded by the existing suites; 3+ are additive.

### Existing tests that guard this area

- `packages/alchemy/test/Cloudflare/Workers/Worker.test.ts` — core deploy lifecycle, script/main workers, hash-driven update behavior.
- `packages/alchemy/test/Cloudflare/Workers/WorkerProvider.test.ts` — unit tests (domain normalization, DO tag packing); add `resolveSource` unit tests here.
- `packages/alchemy/test/Cloudflare/Workers/PrebuiltWorker.test.ts`, `PrebuiltWorkerBundle.test.ts` — `bundle: false` deploy + module-rule walking.
- `packages/alchemy/test/Cloudflare/Workers/PythonWorker.test.ts`, `PythonWorkerLocal.test.ts` — python build/vendoring, python local dev.
- `packages/alchemy/test/Cloudflare/Workers/RandomEnvLocal.test.ts`, `BrowserLocal.test.ts`, `InitIO.test.ts` — local provider behavior (restart signatures, bindings).
- `packages/alchemy/test/Cloudflare/Workers/WorkerCache.test.ts` — metadata-surface updates (#745 path).
- `packages/alchemy/test/Cloudflare/Website/Vite.test.ts` — the vite arm end-to-end: static, SSR, RSC (`react-router-rsc-fixture`), DO-hosting entry (`vite-do-fixture`), SPA, dev bindings (`tanstack-dev-bindings-fixture`).
- `packages/alchemy/test/Cloudflare/Website/StaticSite.test.ts` — AssetsWithHash fast path + `dev: { command }` external mode.

## Tensions & flagged decisions

1. **Local dev of prebuilt workers is wrong today** — `LocalWorkerProvider.runWorker` always calls `bundler.watch(bundleOptions)` for non-python mains, so a `bundle: false` Worker gets re-bundled by rolldown in dev, violating the byte-for-byte contract the deploy path documents ("re-bundling such artifacts is unsafe"). The refactor fixes this structurally (`PrebuiltSource.dev` re-reads instead of bundling). Flagged as a behavior change in step 2 — strictly a bug fix, but worth a changelog line.
2. **Rolldown `hash()` builds.** The maintainer's "recompute without rebuilding" holds for script/vite/prebuilt/frameworks but not for the rolldown arm, and today's code already accepts that (with `Artifacts.cached` making it free across diff→reconcile). Recommendation: keep build-as-hash for rolldown; do not bolt on a source-tree memo now.
3. **Server-mode dev misses queue-consumer restarts.** `runVite` reads `queueConsumers` once at start and never registers in `localRuntimeState.workerRestarts`, while bundle-mode restarts on wiring changes. The `restart?` hook on `SourceDevHandle.server` is the designed fix; wiring it up is optional in step 2 (pre-existing asymmetry, not a regression).
4. **`props.source` and state churn.** Descriptors persist in `olds` and feed the local `structuralSignature`; `options` must therefore stay JSON-stable (documented on the type). Provider version bumps do NOT appear in any hash — a framework package upgrade that changes build output is caught by the `input`-hash… only if inputs changed. Recommendation: providers include their own package version in the `input` hash material (cheap, kills the "upgraded adapter, stale deploy" foot-gun). Genuinely uncertain whether to mandate this in the contract or leave per-provider; recommend mandating it in the JSDoc.
5. **Assets ownership is split** (source-owned for vite/frameworks, props-owned otherwise). Alternative — make every source own assets — was rejected: it would move the AssetsWithHash fast path and `Command.Build` integration (`StaticSite`) into every provider. The split matches the existing mental model (`assets` prop = "serve this directory"; framework = "assets are a build product").
6. **`ViteOptions`/`props.vite` stays `@internal`** and maps to `ViteSource` indefinitely. Collapsing it into a `source` descriptor is possible later but touches persisted props for every deployed vite site; not worth it now.
