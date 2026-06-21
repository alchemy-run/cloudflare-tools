---
name: update-vendored-cloudflare
description: >-
  Update vendored Cloudflare packages under packages/vendor (workers-shared,
  workflows-shared) from the workers-sdk submodule, then sync the coupled
  bindings in packages/cloudflare-runtime/src/bindings. Use when re-vendoring,
  bumping, or updating packages/vendor/*, when the workers-sdk submodule is
  updated, or when asked to pull upstream changes into the vendored Cloudflare
  worker source.
---

# Update vendored Cloudflare packages

Updating a vendored package is a two-part job: (1) re-vendor the package itself,
and (2) sync the downstream `cloudflare-runtime` bindings that re-implement the
corresponding Miniflare plugin. Part 2 is the step people forget — upstream
worker-source changes frequently require matching binding changes.

`packages/vendor/README.md` is the canonical reference for the per-package
mechanics (layout, buckets, `effect/Schema` conventions, import rewrites). This
skill is the orchestration layer that ties the full flow together. Read the
README's [Updating a vendored package](../../../packages/vendor/README.md#updating-a-vendored-package)
section before starting.

## Workflow

```
- [ ] 1. Bump the submodule and scope the change
- [ ] 2. Re-vendor each changed package (per packages/vendor/README.md)
- [ ] 3. Sync downstream cloudflare-runtime bindings (diff Miniflare plugins)
- [ ] 4. Verify everything (vendor packages + cloudflare-runtime)
```

## Step 1 — Bump the submodule and scope the change

Each vendored package records its upstream SHA in its `README.md` (`Provenance`
section / `at commit <sha>`). Capture the old SHA(s), update the submodule, then
diff to see scope.

```bash
git submodule update --remote workers-sdk
git -C workers-sdk rev-parse HEAD        # the new SHA

# For each vendored package, diff old recorded SHA -> HEAD:
git -C workers-sdk diff --stat <old-sha>..HEAD -- packages/workers-shared
git -C workers-sdk diff --stat <old-sha>..HEAD -- packages/workflows-shared
```

If `--remote` leaves the submodule unchanged, the workspace tree already points
at the latest commit; the package READMEs are just behind. Still re-vendor
against `git -C workers-sdk rev-parse HEAD`.

## Step 2 — Re-vendor each changed package

Follow `packages/vendor/README.md`. The critical, easy-to-miss technique:
**vendored files are not verbatim** — isolate real local modifications from
formatting before applying upstream changes.

For each changed file, format-normalize the **old** upstream and diff against
the current vendored copy:

```bash
git -C workers-sdk show <old-sha>:packages/<upstream>/<file> > /tmp/old.ts
cp /tmp/old.ts /tmp/old.fmt.ts
bunx oxfmt format /tmp/old.fmt.ts && bunx oxlint --fix /tmp/old.fmt.ts
diff /tmp/old.fmt.ts packages/vendor/<upstream>/src/<vendored-path>
```

- **Empty diff** → format-only: `cp` the new upstream over the vendored copy.
- **Non-empty diff** → a local mod exists (`zod`→`effect/Schema`, import
  rewrite, `eslint-disable`, `satisfies`): apply the upstream change by hand,
  preserving the local edit.

Known local-modification patterns to preserve:

- **Import rewrites** from the bucket layout. In `workers-shared`, worker
  sources rewrite `../../utils/X` → `../../../shared/X`.
- **`effect/Schema`** in place of upstream `zod` (e.g.
  `workflows-shared/src/lib/validators.ts`, `workers-shared/src/shared/types.ts`).
- **`eslint-disable` comments** upstream may have dropped (e.g.
  `consistent-type-imports` on `typeof import()` in
  `asset-worker/worker-configuration.d.ts`).
- **`satisfies <Type>`** annotations added because our pinned
  `@cloudflare/workers-types` is stricter than upstream's test env.

After copying: reformat, lint-fix, and update the SHA in the package README.

```bash
bunx oxfmt format packages/vendor/<upstream>
bunx oxlint --fix packages/vendor/<upstream>
bun run turbo run typecheck test build --filter @distilled.cloud/vendor-<upstream>
```

## Step 3 — Sync downstream cloudflare-runtime bindings

The bindings in `packages/cloudflare-runtime/src/bindings/<x>` re-implement the
Miniflare plugin for the same feature. When the vendored worker source changes
shape (new env binding, new entrypoint, new compat flag, changed method
signature), the binding must change too. Derive the required changes by diffing
the Miniflare plugin between the same two SHAs:

```bash
# Plugin wiring (getBindings / getServices) + the worker templates:
git -C workers-sdk diff <old-sha>..HEAD -- \
  packages/miniflare/src/plugins/<feature> \
  packages/miniflare/src/workers/<feature>
```

Map Miniflare concepts → `cloudflare-runtime`:

| Miniflare                                              | cloudflare-runtime                                                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `src/plugins/<x>/index.ts` `getBindings`/`getServices` | the `*.ts` plugin (e.g. `bindings/assets/Assets.ts`, `bindings/workflows/Workflows.ts`) |
| `src/workers/<x>/*.worker.ts` (re-export templates)    | the matching `*.worker.ts` re-export (e.g. `bindings/assets/router.worker.ts`)          |
| service `bindings: [{ name, ... }]`                    | the `bindings: [...]` array in the plugin's service definition                          |
| `compatibilityFlags` on a service                      | the `compatibilityFlags` on the corresponding service/middleware                        |

Apply only changes coupled to the vendored update. **Skip** Miniflare-internal
mechanisms that `cloudflare-runtime` implements differently — e.g. the
dev-registry proxy / `external` rerouting (we use our own `RegistryProxy`
subscribe/publish), or the remote `rpc-proxy` worker (not used by the local
binding). When unsure whether a change is coupled, check whether the vendored
worker source actually reads the new binding/flag/signature; if it does, it's
required.

> **Always re-run `bun run build` in `cloudflare-runtime` after editing any
> internal `.worker.ts` file** — the `worker:` imports are bundled at build
> time, so typecheck/test won't reflect edits until you rebuild.

## Step 4 — Verify

```bash
# vendored packages
bunx oxlint packages/vendor
bunx oxfmt format --check packages/vendor
bun run turbo run typecheck test build --filter "@distilled.cloud/vendor-*"

# downstream
cd packages/cloudflare-runtime && bun run build && cd -
bun run turbo run typecheck --filter @distilled.cloud/cloudflare-runtime
# target the affected binding suites, e.g.:
( cd packages/cloudflare-runtime && bunx vitest run test/bindings/Assets.test.ts test/bindings/Workflows.test.ts )
```

All four must be green: vendored tests guard semantic regressions, typecheck
guards shape changes, lint/format guards style, and the binding tests guard the
downstream wiring.

## Worked example (last update)

Bumping `workers-shared` + `workflows-shared` to a newer `workers-sdk` HEAD
required these coupled binding changes, all derived from the Miniflare diffs:

- **Assets** (router gained a `ctx.exports` loopback inner entrypoint):
  `bindings/assets/router.worker.ts` re-exports `RouterInnerEntrypoint`, and the
  `assets:router` service in `bindings/assets/Assets.ts` added the
  `enable_ctx_exports` compat flag.
- **Workflows**: `bindings/workflows/Workflows.ts` added a `WORKFLOW_NAME`
  engine binding (the vendored `WorkflowBinding` now reads `env.WORKFLOW_NAME`),
  and `bindings/workflows/wrapped-binding.worker.ts` `restart()` now forwards
  `WorkflowInstanceRestartOptions`.
