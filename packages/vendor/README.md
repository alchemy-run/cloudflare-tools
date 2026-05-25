# Vendored packages

This directory holds private workspace packages that vendor raw TypeScript
source from upstream third-party repositories (currently various internal
Cloudflare worker packages from
[`cloudflare/workers-sdk`](https://github.com/cloudflare/workers-sdk)).

Each vendored upstream gets its own workspace package named
`@distilled.cloud/vendor-<upstream-name>` and lives at
`packages/vendor/<upstream-name>/`.

These packages:

- Are `"private": true` and never published.
- Ship raw `.ts` from `src/` via the `exports` map — consumers bundle into
  their own outputs; we do not ship a `dist/`.
- Run `build`, `typecheck`, and `test` scripts (see [Scripts](#scripts) below).
- Conform to the repo's `oxlint` + `oxfmt` rules. Where upstream patterns can't
  be made compliant trivially, narrow rule overrides live in
  [`.oxlintrc.json`](../../.oxlintrc.json) scoped to `packages/vendor/*/src/**`.

## Layout convention

Every vendored package uses the same `src/` layout, mirroring this repo's
`.worker.ts` / `.shared.ts` convention but expressed as directories:

```
packages/vendor/<upstream-name>/
  package.json
  README.md                      (provenance + upstream commit SHA + file map)
  tsconfig.json                  (solution; references the three below)
  tsconfig.workers.json
  tsconfig.shared.json
  tsconfig.node.json
  vitest.config.ts               (one root config with four projects)
  src/
    index.ts                     (Node-facing barrel, typechecked under node)
    workers/                     (code that runs in the Workers runtime)
      <worker-name>/
        index.ts
        src/...
        tests/...
        wrangler.jsonc
    shared/                      (isomorphic code: web-platform APIs only)
      ...
      tests/...
    node/                        (Node-only build/config-time code)
      ...
      tests/...
```

### tsconfig bucket semantics

| Bucket  | Glob                          | Types                                                                             | Purpose                                                                  |
| ------- | ----------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| workers | `src/workers/**`              | `@cloudflare/workers-types/experimental`, `@cloudflare/vitest-pool-workers/types` | Worker runtime code + colocated tests                                    |
| shared  | `src/shared/**`               | workers-types **and** `node`                                                      | Isomorphic code; intersection typing catches accidental env-specific use |
| node    | `src/node/**`, `src/index.ts` | `node`                                                                            | Node-only helpers (anything that imports `node:*` or uses `process.*`)   |

`tsconfig.json` is a solution file that references all three via
`emitDeclarationOnly: true` (project references require emit).

## Scripts

Every vendored package exposes the same script surface:

| Script       | Command      | Purpose                                                                                                            |
| ------------ | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `build`      | `tsc -b`     | Walks the project references and emits `.d.ts` declarations into `.cache/` so consumer packages can resolve types. |
| `typecheck`  | `tsc`        | Type-checks against the solution config without emit. Faster feedback than `build` during development.             |
| `test`       | `vitest run` | Runs all four vitest projects once (see [Testing](#testing)).                                                      |
| `test:watch` | `vitest`     | Re-runs affected tests on change.                                                                                  |

The `build` / `typecheck` split exists because consumer packages (e.g.
`@distilled.cloud/cloudflare-runtime`) use TypeScript project references and
need our emitted `.d.ts` files, while local development wants the fast
no-emit `tsc` invocation.

## Testing

Tests are vendored alongside source and **kept runnable**. Even though we
don't modify upstream behavior often, when we do (refactors, dependency
swaps like `zod` → `effect/Schema`, vendoring out `mime`, etc.) the upstream
test suite is our best regression guard.

A single [`vitest.config.ts`](workers-shared/vitest.config.ts) at the package
root uses Vitest 4's `test.projects` to fan out into four named projects in
one invocation:

| Project         | Environment                                                   | Includes                                       |
| --------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| `node`          | `node`                                                        | `src/node/**/*.test.ts`                        |
| `shared`        | `node`                                                        | `src/shared/**/*.test.ts`                      |
| `<worker-name>` | `@cloudflare/vitest-pool-workers` + upstream `wrangler.jsonc` | `src/workers/<worker-name>/tests/**/*.test.ts` |

The Worker projects load each worker's vendored `wrangler.jsonc` verbatim;
its `main: "src/worker.ts"` path is relative to the wrangler config itself,
so no rewriting is needed.

Skeleton (see [`workers-shared/vitest.config.ts`](workers-shared/vitest.config.ts)
for the full example):

```ts
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "node", include: ["src/node/**/*.test.ts"], environment: "node" } },
      { test: { name: "shared", include: ["src/shared/**/*.test.ts"], environment: "node" } },
      {
        plugins: [
          cloudflareTest({ wrangler: { configPath: "./src/workers/<worker>/wrangler.jsonc" } }),
        ],
        test: {
          name: "<worker>",
          include: ["src/workers/<worker>/tests/**/*.test.ts"],
          testTimeout: 50_000,
        },
      },
    ],
  },
});
```

When adding tests for a new worker, append another `cloudflareTest`-backed
project entry. No new dependencies or config files needed.

### Classifying a file

- Imports `node:*` or uses `process.*` / `Buffer` (outside ambient global use)? → `node/`.
- Uses only Workers runtime APIs (`Request`, `Response`, `crypto.subtle`,
  `KVNamespace`, etc.) or imports `@cloudflare/workers-types`? → `workers/`.
- Pure data, types, parsers, web-platform APIs only? → `shared/`.

When in doubt, place it in `shared/` and let `tsc` complain — if it needs Node
or Worker types it'll tell you.

## Adding a new vendored package

The example below assumes the upstream lives at
`workers-sdk/packages/<upstream>/`. Adjust paths if the source is elsewhere.

1. **Scaffold the package directory.**

   ```bash
   mkdir -p packages/vendor/<upstream>/src/{workers,shared,node}
   ```

   Copy `package.json`, `README.md`, the four `tsconfig.*.json` files, and
   `vitest.config.ts` from [`packages/vendor/workers-shared/`](workers-shared/)
   as a starting point and update:
   - `package.json` → `name: "@distilled.cloud/vendor-<upstream>"`, `description`, `exports` entries for any directory-as-module subpaths.
   - `README.md` → provenance (upstream URL, commit SHA, license), file mapping table.
   - `vitest.config.ts` → add one `cloudflareTest`-backed project per worker (the `node` and `shared` projects work as-is via the glob patterns).
   - tsconfigs typically need no changes — the globs are package-local.

2. **Copy the upstream source.** Use `cp -R` from the in-repo submodule (not
   ad-hoc reproduction) so license headers and structure survive intact. For
   each upstream file, drop it into one of `src/workers/`, `src/shared/`, or
   `src/node/` per the classification rules above.

3. **Fix relative imports** broken by the reclassification. Typical mutations:
   - A file moved into `node/` that imports a sibling now in `shared/` needs
     its `./X` rewritten to `../shared/X` (or `../../shared/X` if it's nested
     in a subdirectory like `node/configuration/`).
   - A worker file that upstream imported with `../../utils/X` now needs
     `../../../shared/X` because the new `workers/<worker>/src/` is one
     directory deeper than upstream's `<worker>/src/`.

4. **Rewrite the barrel.** Make `src/index.ts` re-export the Node-facing API
   surface from the new `./shared/...` and `./node/...` paths (matching what
   the upstream `index.ts` exposed).

5. **Add `exports` entries.** Minimum:

   ```json
   {
     "exports": {
       ".": "./src/index.ts",
       "./*": "./src/*.ts",
       "./package.json": "./package.json"
     }
   }
   ```

   Plus one entry per directory-as-module (anywhere there's a co-located
   `index.ts` you want consumers to import without a trailing filename):

   ```json
   "./workers/<worker-name>": "./src/workers/<worker-name>/index.ts"
   ```

6. **Install and verify.**

   ```bash
   bun install
   bun run turbo run typecheck test --filter @distilled.cloud/vendor-<upstream>
   bunx oxlint lint packages/vendor/<upstream>
   bunx oxfmt format --check packages/vendor/<upstream>
   ```

   If any tests fail against vanilla upstream source, that's a signal something
   was misclassified or an import got rewritten incorrectly — not a green
   light to skip them. Tests must pass before landing the initial vendor.

   If `oxlint` flags upstream patterns that aren't trivially fixable, add the
   specific rules to the existing `packages/vendor/*/src/**/*.ts` override
   block in [`.oxlintrc.json`](../../.oxlintrc.json) rather than disabling them
   globally.

7. **Record the upstream commit SHA** in the package's `README.md`. When the
   submodule is updated and you re-vendor, bump the SHA there so the
   provenance stays accurate.

## Conventions

### Replacing upstream validators with `effect/Schema`

Upstream packages often use `zod` (or hand-rolled `interface`s) to describe
runtime-validated config shapes. We standardize on `effect/Schema` for these
in vendored packages.

The mechanical mapping for the common Zod patterns:

| Zod                                       | `effect/Schema`                                      |
| ----------------------------------------- | ---------------------------------------------------- |
| `z.object({ ... })`                       | `Schema.Struct({ ... })`                             |
| `z.string()` / `.number()` / `.boolean()` | `Schema.String` / `Schema.Number` / `Schema.Boolean` |
| `z.array(X)`                              | `Schema.Array(X)`                                    |
| `z.record(X)`                             | `Schema.Record(Schema.String, X)`                    |
| `z.literal(N)`                            | `Schema.Literal(N)`                                  |
| `z.enum([...])`                           | `Schema.Literals([...])`                             |
| `z.union([X, Y])`                         | `Schema.Union([X, Y])`                               |
| `z.union([X, z.null()])`                  | `Schema.NullOr(X)`                                   |
| Field `.optional()` inside an object      | `Schema.optional(X)`                                 |
| `SchemaA.shape` spread into `z.object`    | Extract a plain fields object and spread it          |
| `z.infer<typeof S>`                       | `typeof S.Type` (wrap in `Mutable<T>` — see below)   |

For standalone `z.object({...}).optional()` exports: define them as bare
`Schema.Struct(...)`s and apply `Schema.optional(...)` at the use site in the
parent struct. Cleaner, and almost always equivalent for vendored code where
the schema isn't re-exported as a top-level parser.

#### Mutability

`Schema.Struct` / `Schema.Array` / `Schema.Record` infer **deeply `readonly`**
types, while Zod's `z.infer<...>` produces fully mutable types. Most upstream
worker code mutates these values (e.g. `config.compatibility_flags.push(...)`,
assigning to record entries) and breaks under `readonly`.

Apply a deep mutability helper to every exported type that originated from a
Schema:

```ts
type Mutable<T> =
  T extends ReadonlyArray<infer U>
    ? Array<Mutable<U>>
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;

export type RouterConfig = Mutable<typeof RouterConfigSchema.Type>;
```

The runtime schema stays canonical; only the type alias is unwrapped. See
[`workers-shared/src/shared/types.ts`](workers-shared/src/shared/types.ts)
for a worked example.

#### Dependency

Add `"effect": "catalog:effect"` to `devDependencies` (the catalog version
range lives in the root `package.json`). Remove the old `zod` entry.

## Updating a vendored package

1. `git submodule update --remote workers-sdk` (or the relevant submodule).
2. Re-`cp` the changed upstream files over the vendored copies.
3. Re-apply the import-path mutations and barrel adjustments (a `git diff` of
   the prior vendored tree against the new submodule contents makes this
   straightforward).
4. Run the verification commands from step 6 above. The test suite catches
   most semantic regressions from upstream changes; the typecheck catches
   shape changes; lint/format catches the rest.
5. Update the upstream commit SHA in the package `README.md`.
