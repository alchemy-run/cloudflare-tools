# fixtures/monorepo-workspace

Exercises the **externalWorkspaces / input-hash memo machinery** with an app
that imports code across a package boundary.

## Layout

```
fixtures/monorepo-workspace/   ← fixture root (bun workspace member; harness cwd)
  e2e.config.ts                ← built-in Vite framework path, re-rooted at app/
  app/                         ← the Vite project root (SSR worker, no client assets)
    src/server.ts              ← imports ../../lib/src/greeting.ts
  lib/                         ← sibling directory with its own package.json + src
    package.json               ← makes lib/ a "workspace root" for the collector
    src/greeting.ts
```

Deliberate choices:

- **Vite framework path, not a framework package.** `e2e.config.ts` wraps the
  harness's built-in `makeViteFramework` with a Framework layer that pins
  `root: app/` for `build`/`dev`. This isolates the workspace machinery from
  framework churn.
- **Relative import, no bun workspace-protocol tricks.** `lib/` is NOT a bun
  workspace member (the root glob is `fixtures/*`, one level up). The app
  reaches it via `../../lib/src/greeting.ts`; framework-core's collector
  detects cross-boundary module ids **by path** (absolute id outside the
  project root, not under `node_modules`) and resolves each to its nearest
  `package.json` directory (`collectExternalWorkspaces`).

## What the specs assert

- `live` + `dev`: the app builds/serves and its SSR HTML + `/api/greeting`
  JSON carry content imported from `lib/`.
- `live`: `dist/build.json`'s `externalWorkspaces` contains the absolute path
  of `lib/` — and does NOT contain `app/` or the fixture root.

## Enablement target: memo-busting assertions

The remaining goal — *editing `lib/src` busts the rebuild memo while an
untouched rebuild stays memoized* — is **not yet assertable in this harness**:

- `e2e build` rebuilds unconditionally (`Server.buildAndPersist` always calls
  `Framework.build()`); the harness has no input-hash memo of its own.
- The memo that consumes `externalWorkspaces` lives in alchemy's
  `Website`/`Command.Memo` machinery (`memo.workspaces: "auto"` hashes the
  workspace directories recorded in the build output).

To make it assertable, either (a) grow a harness-level memoized build (`e2e
build --memo`?) that reuses `dist/build.json` when input hashes match and
exposes whether the build was skipped, or (b) drive this fixture from an
alchemy-side `Website` test. Until then this fixture pins the prerequisite:
the collector must report `lib/` so the memo layer has the right inputs.

## CI gate

`bun run test` prints a pending notice and exits 0 unless `MONOREPO_WS_ENABLE=1`
is set (see `scripts/e2e.mjs`). This keeps CI green while the enablement pass
verifies the nested-root Vite path end to end. Run the real suite with:

```sh
MONOREPO_WS_ENABLE=1 bun run test
```
