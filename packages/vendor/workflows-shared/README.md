# @distilled.cloud/vendor-workflows-shared

Private workspace package vendoring raw TypeScript source from
[`@cloudflare/workflows-shared`](https://github.com/cloudflare/workers-sdk/tree/main/packages/workflows-shared).
This package does not bundle or publish; consumer packages in this monorepo
import the `.ts` files directly and apply their own bundling.

## Layout

All upstream source is Workers-runtime code (uses `cloudflare:workers`, `DurableObject`,
`RpcTarget`, `WorkerEntrypoint`, `crypto.subtle`, etc.) and lives under
`src/workers/workflows-shared/`. There is no Node-facing barrel; consumers
import the worker entrypoint directly:

```ts
import {
  Engine,
  WorkflowBinding,
} from "@distilled.cloud/vendor-workflows-shared/workers/workflows-shared/local-binding-worker";
```

## Provenance

Sourced from [`cloudflare/workers-sdk`](https://github.com/cloudflare/workers-sdk)
at commit `2dc61751451f142dbf93e618133a5c8942c07c9a` (path:
`packages/workflows-shared`). Upstream license: MIT OR Apache-2.0.

| Upstream path                             | Vendored path                                        |
| ----------------------------------------- | ---------------------------------------------------- |
| `src/binding.ts`                          | `src/workers/workflows-shared/src/binding.ts`        |
| `src/context.ts`                          | `src/workers/workflows-shared/src/context.ts`        |
| `src/engine.ts`                           | `src/workers/workflows-shared/src/engine.ts`         |
| `src/instance.ts`                         | `src/workers/workflows-shared/src/instance.ts`       |
| `src/modifier.ts`                         | `src/workers/workflows-shared/src/modifier.ts`       |
| `src/index.ts`                            | `src/workers/workflows-shared/src/index.ts`          |
| `src/local-binding-worker.ts`             | `src/workers/workflows-shared/src/local-binding-worker.ts` |
| `src/lib/*`                               | `src/workers/workflows-shared/src/lib/*`             |
| `tests/*`                                 | `src/workers/workflows-shared/tests/*`               |
| `wrangler.jsonc`                          | `src/workers/workflows-shared/wrangler.jsonc`        |

## Modifications

`src/workers/workflows-shared/src/lib/validators.ts` was rewritten to use
`effect/Schema` in place of upstream `zod`, per the monorepo vendor
conventions in [`packages/vendor/README.md`](../README.md). Behavior is
preserved: strict struct decoding, the same optional/required fields, and
the same `delay`/`timeout` numeric or string union.
