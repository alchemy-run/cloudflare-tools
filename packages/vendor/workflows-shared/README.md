# @distilled.cloud/vendor-workflows-shared

Private workspace package vendoring raw TypeScript source from
[`@cloudflare/workflows-shared`](https://github.com/cloudflare/workers-sdk/tree/main/packages/workflows-shared).
This package does not bundle or publish; consumer packages in this monorepo
import the `.ts` files directly and apply their own bundling.

The upstream source is copied **verbatim** under `src/` and `tests/`, with no
modifications. Only the project metadata (`package.json`, `tsconfig.json`,
`vitest.config.ts`) is rewritten to fit this monorepo's tooling. The upstream
`wrangler.jsonc` is also copied unchanged.

## Provenance

Sourced from [`cloudflare/workers-sdk`](https://github.com/cloudflare/workers-sdk)
at commit `a55b29a4ba8a24f4d539538e2bf38e6a7e5b8e52` (path:
`packages/workflows-shared`). Upstream license: MIT OR Apache-2.0.

## Consumer imports

```ts
// Worker entrypoints (Engine DO + WorkflowBinding entrypoint)
import {
  Engine,
  WorkflowBinding,
} from "@distilled.cloud/vendor-workflows-shared/local-binding-worker";

// Type-only imports of individual modules
import type { Engine } from "@distilled.cloud/vendor-workflows-shared/src/engine";
```
