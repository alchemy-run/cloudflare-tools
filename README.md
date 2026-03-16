# `@distilled.cloud/cloudflare-bundler`

Effect-native bundler for Cloudflare Workers, built on top of esbuild.

## Install

```bash
bun add @distilled.cloud/cloudflare-bundler effect@beta esbuild
```

## Usage

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Bundle } from "@distilled.cloud/cloudflare-bundler";
import { EsbuildBundleLive } from "@distilled.cloud/cloudflare-bundler/esbuild";

const program = Effect.gen(function* () {
  const bundle = yield* Bundle;

  return yield* bundle.build({
    main: "/absolute/path/to/src/index.ts",
    projectRoot: "/absolute/path/to/project",
    outputDir: "/absolute/path/to/dist",
    compatibilityDate: "2026-03-10",
    compatibilityFlags: ["nodejs_compat"],
    minify: true,
  });
});

const layer = Layer.provide(EsbuildBundleLive, Layer.mergeAll(NodeFileSystem.layer, NodePath.layer));

const result = await Effect.runPromise(Effect.provide(program, layer));
console.log(result.main);
```

`build()` returns the bundled entry file path, detected module type, output directory, and any collected extra modules.

## Bundle options

- Required: `main`, `projectRoot`, `outputDir`
- Common options: `compatibilityDate`, `compatibilityFlags`, `define`, `external`, `minify`, `keepNames`, `tsconfig`, `format`
- Cloudflare module support: `rules`, `findAdditionalModules`, `preserveFileNames`

## Development

```bash
bun install
bun run build
bun run test
```

## License

MIT
