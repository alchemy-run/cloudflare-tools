---
name: port-miniflare-binding
description: >-
  Port a Miniflare binding simulator (KV, R2, D1, Cache, Queues, ...) into
  packages/cloudflare-runtime as a local binding plugin with a Durable
  Object-backed worker and a full test suite adapted from upstream. Use when
  implementing a new local binding in cloudflare-runtime, porting or adapting a
  Miniflare plugin/worker, or when asked to add local support for a Cloudflare
  binding type.
---

# Port a Miniflare binding into cloudflare-runtime

This extends the "Adding a new binding type" section of `AGENTS.md` with the
concrete architecture and pitfalls from the KV and R2 ports. Use
`src/bindings/kv-namespace` as the reference for a complete simple port and
`src/bindings/r2-bucket` for a complex one (multipart state, ranged blob
reads, `nodejs_compat`). The goal is **100% parity with the upstream Miniflare
test suite**, adapted case by case.

## Workflow

```
- [ ] 1. Study the Miniflare plugin, workers, and tests
- [ ] 2. Create the binding directory and shared options file
- [ ] 3. Port the worker (one self-contained .worker.ts)
- [ ] 4. Write the plugin (register API, deferred services, control endpoints)
- [ ] 5. Wire up: index.ts, RuntimeServices.ts, package.json exports
- [ ] 6. Port the upstream test suite
- [ ] 7. Verify: build, typecheck, tests, `bun run check` at repo root
```

## Step 1 — Study upstream

Read all of:

- `workers-sdk/packages/miniflare/src/plugins/<feature>/` — `getBindings`
  (what the user worker's binding designator looks like) and `getServices`
  (services + DO namespaces + persistence wiring).
- `workers-sdk/packages/miniflare/src/workers/<feature>/` — the simulator
  itself, usually fragmented across many files, plus the parts of
  `workers/shared/*` it uses.
- `workers-sdk/packages/miniflare/test/plugins/<feature>/` — every test case
  to port, including in-worker fixture tests under `test/fixtures/`.

## Step 2 — Directory and shared options

Layout under `src/bindings/<feature>/` (kebab-case):

```
<Feature>.ts                  # plugin + local/remote hooks
<Feature>.worker.ts           # the simulator worker
<Feature>Options.shared.ts    # props interfaces + name constants
index.ts                      # re-exports (except nothing extra)
```

`<Feature>Options.shared.ts` holds: the `local` hook props, the
`XServiceProps` interface passed via designator props, `SERVICE_*` /
`BINDING_*` / `HEADER_*` constants, and any **runtime-agnostic logic needed by
both the worker and Node-side tests** (e.g. R2's `testR2Conditional`, which
upstream tests from Node). `.shared.ts` files are type-checked against both
node and workers types, so no `Fetcher`/`node:*` references.

## Step 3 — Port the worker

**Topology (differs from Miniflare):** one service hosts _every_ instance of
the binding (all namespaces/buckets). Miniflare creates a per-instance entry
worker; here the instance name travels on the designator instead:

- The binding designator is
  `{ name: SERVICE_X, props: { json: JSON.stringify({ instanceName }) } }`.
- The worker's default `fetch` reads `ctx.props`, routes with
  `env.OBJECT.getByName(instanceName)`, and forwards the (URI-encoded)
  instance name in an internal header — the Durable Object needs it to
  namespace `BlobStore` paths on disk, mirroring Miniflare's persistence
  layout (blobs keyed by name, not DO id).

**Consolidate.** Collapse Miniflare's fragmented worker files into one
`.worker.ts`, with section comments citing the upstream file each part came
from. Utilities already shared between simulators live in
`src/internal/shared.worker.ts` (`assert`, `HttpError`, `Timers`,
`maybeApply`, base64/hex helpers, `utf8ByteLength`, `InclusiveRange`,
`BlobStore`). Import from there; move a utility there only once a second
worker needs it. (That file uses a `.worker.ts` suffix so it's checked
against workers-types, but is excluded from the worker entries in
`tsdown.config.ts` and bundled into importers as a shared chunk.)

**Adaptation rules:**

- Replace upstream `zod` schemas with hand-written `decode*` functions —
  workerd is a trusted client; decoders just normalise the wire format
  (renames, `Number`/`Date` coercion, base64/hex decoding).
- Avoid `Buffer` and Node built-ins. If one is genuinely required (R2 needs
  `node:crypto`'s sync `createHash` because multipart etags are computed
  inside SQLite transactions, which cannot await), enable `nodejs_compat` on
  the service in the plugin **and** give the worker its own build config in
  `tsdown.config.ts` with `compatibilityFlags: ["nodejs_compat"]` — the
  `cloudflare()` rolldown plugin flags apply per build. Copy the R2 entry:
  named entry to keep the output path, `clean: false`.
- Metadata in DO SQLite (`state.storage.sql`, positional `?1` params,
  `transactionSync` for atomic read-modify-write), values in `BlobStore`
  backed by a `<feature>:storage` disk service. Delete replaced blobs in the
  background via `timers.queueMicrotask`; if reads can be in-flight during
  deletes, guard blobs with a `WaitGroup` (see R2).
- Control endpoints for tests: a reserved header carries `{ name, args }`
  ops — timer methods (`enableFakeTimers`, `advanceFakeTime`,
  `waitForFakeTasks`), `sqlQuery`, `getBlob` — gated by an env binding the
  plugin only emits when enabled. Receiving a control op sets a
  `beingTested` flag, used to shrink limits (e.g. max value size) in tests.
- In the DO's `fetch`, always consume unread request bodies in a `finally`
  (`req.body.pipeTo(new WritableStream())`) or callers can hang
  (cloudflare/workerd#960).

> **Re-run `bun run build` after editing any `.worker.ts`** — `worker:`
> imports are bundled at build time; typecheck/tests won't see edits until
> you rebuild.

## Step 4 — Write the plugin

Follow `KvNamespace.ts` / `R2Bucket.ts` closely:

- `Plugin.Service` exposing one API: `register(props: XServiceProps)` which
  sets a `used` flag and returns the designator. The `defer` callback emits
  the storage + simulator services **only if `used`** — no bindings, no
  services.
- The storage disk service persists under `{storage}/<feature>`; fail with a
  `ConfigError` (subtag, message, hint) when the Storage layer has no disk
  path.
- DO namespace: `enableSql: true`, `uniqueKey: "cloudflare-runtime-<Class>"`,
  `preventEviction: true`, `durableObjectStorage: { localDisk: SERVICE_X_STORAGE }`.
- Control endpoints are gated by the shared
  `Plugin.UnsafeEnableControlEndpoints` `Context.Reference` (tests provide
  `Layer.succeed(Plugin.UnsafeEnableControlEndpoints, true)`); when true, add
  a `{ name: BINDING_X_ENABLE_CONTROL_ENDPOINTS, json: "true" }` binding.
- `local` hook via `Plugin.use`; `remote` via `makeRemoteBinding` with the
  Cloudflare API binding object (`raw: true`).

## Step 5 — Wire up

- `src/bindings/<feature>/index.ts`: `export *` of the plugin and options.
- `src/bindings/index.ts`: `export * as <Feature> from "./<feature>/index.ts"`.
- `src/RuntimeServices.ts`: add `<Feature>Live` to `layerLocalBindings` and
  the service to the `BindingServices` union (alphabetical).
- `package.json` exports are generated by `bun run build` (tsdown's
  `exports` option; `.shared` suffixes are stripped from export keys) —
  after building, verify entries for the new directory appeared.

## Step 6 — Port the test suite

Copy the structure of `test/bindings/KvNamespace.test.ts` /
`R2Bucket.test.ts`. Miniflare drives bindings from Node through its magic
proxy; this runtime has no equivalent, so:

- A `TEST_SCRIPT` worker exposes the binding over HTTP (`POST /<feature>`
  with a JSON op) and forwards `/control` to a raw `CONTROL` service binding
  — a designator constructed inline with the same `SERVICE_X` + props JSON
  (relying on the real binding to make the services exist).
- A Node-side `Namespaced<X>` client mirrors the binding API and prefixes
  keys with a per-test `ns` so tests sharing one instance don't race. Rethrow
  worker errors with the original constructor (`TypeError` vs `Error`) so
  upstream error assertions hold.
- A `ControlStub` sends `{ name, args }` to `/control`:
  `enableFakeTimers(ts)` in setup, `waitForFakeTasks()` before asserting
  background blob deletion, `sqlQuery`/`getBlob` for storage assertions.
- Suite layer: `<X>TestWorkerLive.pipe(Layer.provideMerge(localRuntimeLayer),
Layer.provide(Layer.succeed(Plugin.UnsafeEnableControlEndpoints, true)))`.
- Persistence test: build a runtime layer over `Storage.layerDisk(tmp)`, run
  the worker twice ("restart"), and assert the on-disk layout
  (`{tmp}/<feature>/cloudflare-runtime-<Class>` + per-instance blob dir).
- Port **every** upstream case; document intentionally skipped ones (and any
  semantic deltas from the HTTP transport, e.g. eager body reads changing
  blob-deletion timing) in the file header comment.

Watch for: workerd **errors** on compatibility flags that are already
default-on for the chosen date (e.g. `r2_list_honor_include`) — don't pass
them.

## Step 7 — Verify

```bash
cd packages/cloudflare-runtime
bun run build && bun run typecheck
bunx vitest run test/bindings/<Feature>.test.ts
bun run test                # full package suite
cd ../.. && bun run check   # repo-wide lint/format/typecheck/build
```
