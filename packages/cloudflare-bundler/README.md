# `@distilled.cloud/cloudflare-bundler`

Effect-native Cloudflare Workers bundler built around a common core API with a Rolldown backend.

## Install

```bash
bun add @distilled.cloud/cloudflare-bundler effect@beta rolldown
```

## Usage

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Bundler } from "@distilled.cloud/cloudflare-bundler";
import { RolldownBundler } from "@distilled.cloud/cloudflare-bundler/rolldown";

const program = Effect.gen(function* () {
  const bundler = yield* Bundler;

  return yield* bundler.build({
    main: "./src/index.ts",
    rootDir: "/absolute/path/to/project",
    outDir: "/absolute/path/to/project/dist",
    minify: true,
    cloudflare: {
      compatibilityDate: "2026-03-10",
      compatibilityFlags: ["nodejs_compat"],
      additionalModules: {
        rules: [{ type: "CompiledWasm", globs: ["**/*.wasm"] }],
      },
    },
  });
});

const layer = Layer.provide(RolldownBundler, Layer.mergeAll(NodeFileSystem.layer, NodePath.layer));

const result = await Effect.runPromise(Effect.provide(program, layer));
console.log(result.outDir, result.main, result.modules, result.warnings);
```

`build()` returns an `Output` with:

- `outDir`: absolute output directory
- `main`: relative path to the entry chunk within that directory
- `modules`: all emitted modules, including the main ESM chunk and supported asset modules
- `warnings`: normalized build warnings

## API

The public API is centered on:

- `Bundler` in `src/Bundler.ts`
- `Output` in `src/Output.ts`
- `Module` in `src/Module.ts`

The current backend is:

- `RolldownBundler` from `@distilled.cloud/cloudflare-bundler/rolldown`

## Build Options

- Required: `main`
- Common options: `rootDir`, `outDir`, `define`, `external`, `minify`, `keepNames`, `tsconfig`, `sourcemap`
- Cloudflare options: `cloudflare.compatibilityDate`, `cloudflare.compatibilityFlags`
- Additional module support: `cloudflare.additionalModules.rules`, `cloudflare.additionalModules.preserveFileNames`

## Current v1 Scope

- Build-only
- ESM-only
- Rolldown-only
- `cloudflare:*` externals
- Node.js compatibility via `unenv` and Cloudflare presets
- Additional modules for statically imported text, data, and wasm assets

## Out Of Scope In v1

- Watch mode
- Service-worker / IIFE output
- Rspack and esbuild adapters
- Wrangler-specific `__STATIC_CONTENT_MANIFEST`
- Filesystem scanning for dynamic import targets

## License

MIT
