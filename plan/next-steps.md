# Rewrite Report

## What Was Removed

- The legacy Wrangler-shaped public API in `src/bundle.ts`.
- The old shared Wrangler/esbuild support files:
  - `src/backend-utils.ts`
  - `src/cloudflare-defaults.ts`
  - `src/module-rules.ts`
  - `src/module.ts`
- The abandoned Effect/esbuild bridge and older esbuild implementation:
  - `src/esbuild-v2/EsbuildBundler.ts`
  - `src/esbuild/`
- The rspack implementation:
  - `src/rspack/`
- The copied rolldown plugin implementations under `src/rolldown/plugins/`.
- The old core helper services that only existed to support the previous architecture:
  - `src/core/CloudflareInternal.ts`
  - `src/core/NodeCompatWarning.ts`
  - `src/core/Unenv.ts`
  - `src/core/Utils.ts`
- Out-of-scope tests and harnesses:
  - `test/bundles/watch.test.ts`
  - `test/bundles/service-worker.test.ts`
  - `test/bundles/static-content-manifest.test.ts`
  - `test/bundles/additional-modules.test.ts`
  - `test/bundles/test.ts`
  - `test/harness/esbuild-bundler.ts`
  - `test/harness/rspack-bundler.ts`
  - `test/harness/wrangler-bundler.ts`

## What Was Added

- A rolldown-first public API centered on:
  - `src/core/Bundler.ts`
  - `src/core/Output.ts`
  - `src/core/Module.ts`
  - `src/core/Error.ts`
- A new `unplugin`-based plugin layer in `src/plugins/`:
  - `cloudflare-externals`
  - `nodejs-compat`
  - `nodejs-compat-warnings`
  - `additional-modules`
  - `wasm-helper`
  - plugin composition in `src/plugins/index.ts`
- A rewritten rolldown adapter in:
  - `src/rolldown/bundle.ts`
  - `src/rolldown/index.ts`
- A simplified additional-modules model based on explicit asset rules and ESM output.
- A rewritten test harness around `Output` instead of the old `BundleResult` shape.
- `test/harness/output.ts` to centralize output file resolution.
- A fixture package for `test/fixtures/build-conditions/` so condition ordering is actually exercised.
- `unplugin` as a dependency in `package.json`.

## Current v1 Shape

- Build-only API.
- ESM-only output.
- Rolldown-only backend.
- Node compat via virtual worker entry and `unenv`.
- Additional modules for statically imported text/data/wasm assets.
- No watch mode.
- No service-worker/IIFE mode.
- No `__STATIC_CONTENT_MANIFEST`.
- No filesystem discovery for dynamic import targets.

## Potential Next Steps

### Product / Feature Work

- Reintroduce esbuild as a secondary adapter using the new `src/core` contract rather than reviving any deleted Wrangler-shaped code.
- Reintroduce rspack only after the new plugin contract is stable.
- Add watch mode back as a separate capability instead of putting it back into the main v1 `Bundler` contract immediately.
- Decide whether dynamic additional-module discovery should return in a new, explicit form rather than as Wrangler-style filesystem scanning.
- Decide whether preserving `.js` as JSX-by-default is truly part of the product or just compatibility baggage.

### Architecture / Refactoring

- Make the rolldown implementation more Effect-native:
  - replace the remaining Node `fs/promises` usage in plugin/output rewriting with Effect file services
  - move plugin-chain construction behind Effect services/layers if you want runtime-swappable implementations
  - normalize plugin diagnostics more cleanly at the core boundary
- Consider splitting the current `src/rolldown/bundle.ts` into:
  - config derivation
  - plugin assembly
  - output/materialization
  - diagnostic mapping
- Decide whether `src/nodejs-compat-env.ts` should stay as a thin imperative helper or become part of an Effect service.

### Tests / Verification

- Add more direct tests around emitted `Output.modules` shape, not just runtime behavior.
- Add dedicated tests for the rewritten additional-modules asset rewriting.
- Add adapter conformance tests if/when esbuild or rspack return.

### Documentation

- Update `README.md` to reflect the new rolldown-only API and remove references to esbuild/rspack subpath exports.
- Add a short architecture note explaining the `src/core` contract plus `src/plugins` plus `src/rolldown` layering.
- Document the intentional v1 exclusions so future work does not accidentally reintroduce removed Wrangler behavior.
