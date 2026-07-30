import { DurableObjectNamespace, Text } from "@distilled.cloud/cloudflare-runtime/bindings";
import * as Options from "@distilled.cloud/e2e/Options";
import * as Nuxt from "@distilled.cloud/nuxt";

const SECRET = "s3cret-from-binding";

/**
 * A Nuxt 4 app built through nitro's `cloudflare_module` preset
 * (wrangler-free), with the user's own Durable Object hosted on the SAME
 * worker via the nitro entry/exports seam (`main: "./worker-entry.ts"`).
 */
export default Options.make({
  // The typed factory form (harness contract form 3): map the harness
  // options onto Nuxt options, then pin the dev port so parallel fixture
  // runs don't collide. `framework: "@distilled.cloud/nuxt"` (the string
  // form) works identically when no framework-specific options are needed.
  // The deploy target defaults to `@distilled.cloud/nuxt/cloudflare`.
  framework: (options) => {
    const base = Nuxt.fromHarnessOptions(options as Nuxt.HarnessOptions);
    return Nuxt.layer({ ...base, dev: { port: 3111 } });
  },
  target: {
    cloudflare: {
      worker: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        // The user-entry seam: nitro bundles this module as the worker
        // entry; it wraps nitro's handler and exports the Counter DO class.
        main: "./worker-entry.ts",
        worker: {
          name: "fixtures-nuxt",
          bindings: [
            Text.local("FIXTURE_SECRET", SECRET),
            // Bind the namespace for a DO class exported by THIS worker.
            DurableObjectNamespace.local({ binding: "COUNTER", className: "Counter" }),
          ],
          // The dev runtime's DO declaration (workerd durableObjectNamespaces).
          durableObjectNamespaces: [{ className: "Counter", sql: true }],
          assets: {
            htmlHandling: "auto-trailing-slash",
            notFoundHandling: "none",
          },
        },
      },
      preview: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { FIXTURE_SECRET: SECRET },
        // Miniflare's DO declaration for the preview server: binding name ->
        // class exported by the built worker bundle.
        durableObjects: { COUNTER: { className: "Counter", useSQLite: true } },
        assets: {
          binding: "ASSETS",
          routerConfig: {
            has_user_worker: true,
            invoke_user_worker_ahead_of_assets: false,
          },
          assetConfig: {
            html_handling: "auto-trailing-slash",
            not_found_handling: "none",
          },
        },
      },
    },
  },
});
