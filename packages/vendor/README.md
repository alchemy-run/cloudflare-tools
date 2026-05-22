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
- Ship raw `.ts` from `src/` via the `exports` map — no bundling, no `dist/`.
- Only run `typecheck` (no `build`, no `test`). Consumer packages handle
  bundling and any test wiring themselves.
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

   Copy `package.json`, `README.md`, and the four `tsconfig.*.json` files from
   [`packages/vendor/workers-shared/`](workers-shared/) as a starting point and
   update:
   - `package.json` → `name: "@distilled.cloud/vendor-<upstream>"`, `description`, `exports` entries for any directory-as-module subpaths.
   - `README.md` → provenance (upstream URL, commit SHA, license), file mapping table.
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
   bun run turbo run typecheck --filter @distilled.cloud/vendor-<upstream>
   bunx oxlint lint packages/vendor/<upstream>
   bunx oxfmt format --check packages/vendor/<upstream>
   ```

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

| Zod                                     | `effect/Schema`                                  |
|-----------------------------------------|--------------------------------------------------|
| `z.object({ ... })`                     | `Schema.Struct({ ... })`                         |
| `z.string()` / `.number()` / `.boolean()` | `Schema.String` / `Schema.Number` / `Schema.Boolean` |
| `z.array(X)`                            | `Schema.Array(X)`                                |
| `z.record(X)`                           | `Schema.Record(Schema.String, X)`                |
| `z.literal(N)`                          | `Schema.Literal(N)`                              |
| `z.enum([...])`                         | `Schema.Literals([...])`                         |
| `z.union([X, Y])`                       | `Schema.Union([X, Y])`                           |
| `z.union([X, z.null()])`                | `Schema.NullOr(X)`                               |
| Field `.optional()` inside an object    | `Schema.optional(X)`                             |
| `SchemaA.shape` spread into `z.object`  | Extract a plain fields object and spread it      |
| `z.infer<typeof S>`                     | `typeof S.Type` (wrap in `Mutable<T>` — see below) |

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
type Mutable<T> = T extends ReadonlyArray<infer U>
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
4. Run the verification commands from step 6 above.
5. Update the upstream commit SHA in the package `README.md`.
