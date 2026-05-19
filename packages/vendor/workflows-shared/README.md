# @distilled.cloud/vendor-workflows-shared

Private workspace package vendoring raw TypeScript source from
[`@cloudflare/workflows-shared`](https://github.com/cloudflare/workers-sdk/tree/main/packages/workflows-shared).
This package does not bundle or publish; consumer packages in this monorepo
import the `.ts` files directly and apply their own bundling.

Sibling vendored packages live alongside this one under `packages/vendor/`
(e.g. [`packages/vendor/workers-shared`](../workers-shared/) for
`@cloudflare/workers-shared`).

## Layout

The upstream `@cloudflare/workflows-shared` package is, in its entirety, code
that runs in the Workers runtime (Durable Object engine + RPC binding +
local-binding worker). There is no Node-only or isomorphic surface, so all
source lives under the `workers/` bucket:

- `src/workers/workflows-shared/` — the upstream package, with its original
  `src/`, `tests/`, and `wrangler.jsonc` preserved. Typechecked against
  `@cloudflare/workers-types` plus `@cloudflare/vitest-pool-workers/types`.

The `shared/` and `node/` buckets exist (as enforced by the vendor layout
convention) but have no files. `src/index.ts` is an empty barrel — consumers
should import the Workers entry directly via `./workers/workflows-shared`.

## Provenance

Sourced from [`cloudflare/workers-sdk`](https://github.com/cloudflare/workers-sdk)
at commit `2dc61751451f142dbf93e618133a5c8942c07c9a` (path:
`packages/workflows-shared`). Upstream license: MIT OR Apache-2.0.

| Upstream path    | Vendored path                                 |
| ---------------- | --------------------------------------------- |
| `src/`           | `src/workers/workflows-shared/src/`           |
| `tests/`         | `src/workers/workflows-shared/tests/`         |
| `wrangler.jsonc` | `src/workers/workflows-shared/wrangler.jsonc` |

### Mutations applied

- `src/lib/retries.ts` — upstream imports `ResolvedStepConfig` / `StepState`
  from a placeholder `"shared"` module with a `@ts-expect-error`. Both types
  are actually defined in the sibling `../context.ts`; the import has been
  rewritten accordingly and the `@ts-expect-error` removed.
- `src/lib/validators.ts` — upstream uses `zod` for `STEP_CONFIG_SCHEMA`.
  Rewritten on top of `effect/Schema` to keep the vendor tree on a single
  validation library (matching `vendor-workers-shared`) and to avoid adding
  `zod` to the dependency graph. `isValidStepConfig` retains identical
  semantics: shape check via `Schema.is`, followed by the same
  `ms()`-based delay / timeout sanity checks.

## Consumer imports

```ts
// Worker entry — re-exports of upstream src/index.ts plus named exports of
// the two DO / WorkerEntrypoint classes that consumers typically register.
import {
  Engine,
  WorkflowBinding,
} from "@distilled.cloud/vendor-workflows-shared/workers/workflows-shared";

// Any individual module under the package via the wildcard
import { InstanceStatus } from "@distilled.cloud/vendor-workflows-shared/workers/workflows-shared/src/instance";
import { calcRetryDuration } from "@distilled.cloud/vendor-workflows-shared/workers/workflows-shared/src/lib/retries";
```
