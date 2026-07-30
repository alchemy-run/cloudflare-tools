import { makeViteFramework } from "@distilled.cloud/e2e/Framework";
import * as Options from "@distilled.cloud/e2e/Options";
import { Framework } from "@distilled.cloud/framework-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

/**
 * The Vite project root is `app/`, NOT the fixture root. That is the point of
 * this fixture: `app/src/server.ts` imports `../../lib/src/greeting.ts`, a
 * module that lives OUTSIDE the project root in a sibling directory with its
 * own `package.json` — the shape of a monorepo workspace member importing a
 * sibling package by path. The build-output collector must classify `lib/` as
 * an external workspace (`dist/build.json` → `externalWorkspaces`).
 */
export const APP_ROOT = NodePath.join(import.meta.dirname, "app");

/** The workspace root the collector must discover (lib/ has a package.json). */
export const LIB_ROOT = NodePath.join(import.meta.dirname, "lib");

/**
 * Wrap a Framework layer so `build`/`dev` default to `APP_ROOT` as the project
 * root. The harness's cwd is the fixture root (where `dist/build.json` is
 * persisted); the app itself lives one level down.
 */
const withAppRoot = (base: Options.Options.FrameworkLayer): Options.Options.FrameworkLayer =>
  Layer.effect(
    Framework,
    Effect.gen(function* () {
      const framework = yield* Framework;
      // Harness gap workaround: `Server.buildAndPersist` writes
      // `<cwd>/dist/build.json` but framework-core's `writeBuildOutput` does
      // not create the parent directory. With a nested project root the Vite
      // build writes to `app/dist`, so `<fixtureRoot>/dist` never exists
      // (`dist` is gitignored repo-wide, so it can't be checked in either).
      // Pre-create it before every build. Enablement target: writeBuildOutput
      // should `mkdir -p` the parent, then this can go.
      const ensureDistDirectory = Effect.sync(() => {
        NodeFs.mkdirSync(NodePath.join(import.meta.dirname, "dist"), { recursive: true });
      });
      return Framework.of({
        build: (options) =>
          ensureDistDirectory.pipe(
            Effect.andThen(framework.build({ ...options, root: options?.root ?? APP_ROOT })),
          ),
        dev: (options) => framework.dev({ ...options, root: options?.root ?? APP_ROOT }),
      });
    }),
  ).pipe(Layer.provide(base));

export default Options.make({
  target: {
    cloudflare: {
      worker: {
        // Worker entry, relative to the Vite root (app/).
        main: "./src/server.ts",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: {
          name: "fixtures-monorepo-workspace",
          bindings: [],
        },
      },
      preview: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
      },
    },
  },
  // The built-in Vite framework path (this fixture deliberately does NOT use
  // one of the framework packages — it isolates the workspace machinery from
  // framework churn), re-rooted at app/.
  framework: (options) => withAppRoot(makeViteFramework(options)),
});
