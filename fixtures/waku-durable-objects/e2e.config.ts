import { DurableObjectNamespace, Text } from "@distilled.cloud/cloudflare-runtime/bindings";
import * as Options from "@distilled.cloud/e2e/Options";
import wakuFramework from "@distilled.cloud/waku";

export const FIXTURE_MESSAGE = "hello-from-waku-do-binding";

/**
 * INTENDED-BEHAVIOR CONFIG (see README): a waku app plus the user's own
 * Durable Object hosted on the SAME worker. The user's `main` module
 * (src/worker-entry.ts) wraps waku's emitted fetch handler and additionally
 * exports `class Counter` (a SQLite DO).
 *
 * Today `@distilled.cloud/waku`'s cloudflare target unconditionally pins
 * `main` to waku's own rsc server entry (makeWakuPluginOptions in
 * packages/waku/src/cloudflare.ts), so the `main` below is silently ignored
 * and the DO class never reaches the deployed module graph. The e2e `test`
 * script is gated on WAKU_DO_ENABLE=1 until the seam lands.
 */
export default Options.make({
  target: {
    cloudflare: {
      worker: {
        // The custom-entry seam: precedence over waku's pinned rsc entry,
        // mirroring Website.Vite's `main` ("Custom Worker Entry" JSDoc in
        // packages/alchemy/src/Cloudflare/Website/Vite.ts). The module wraps
        // waku's server entry and re-exports the Counter DO class.
        main: "./src/worker-entry.ts",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_als"],
        worker: {
          name: "fixtures-waku-durable-objects",
          bindings: [
            Text.local("MESSAGE", FIXTURE_MESSAGE),
            // Bind the namespace for a DO class exported by THIS worker.
            DurableObjectNamespace.local({ binding: "COUNTER", className: "Counter" }),
          ],
          // The dev runtime's DO declaration (workerd durableObjectNamespaces).
          durableObjectNamespaces: [{ className: "Counter", sql: true }],
          assets: {
            htmlHandling: "drop-trailing-slash",
            notFoundHandling: "none",
          },
        },
      },
      preview: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_als"],
        bindings: { MESSAGE: FIXTURE_MESSAGE },
        // Miniflare's DO declaration for the preview server: binding name ->
        // class exported by the built worker bundle.
        durableObjects: { COUNTER: { className: "Counter", useSQLite: true } },
        assets: {
          routerConfig: {
            has_user_worker: true,
            invoke_user_worker_ahead_of_assets: false,
          },
          assetConfig: {
            html_handling: "drop-trailing-slash",
            not_found_handling: "none",
            has_static_routing: false,
          },
        },
      },
    },
  },
  framework: (options) => wakuFramework({ ...options, port: 3110 }),
});
