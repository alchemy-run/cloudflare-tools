import * as Astro from "@distilled.cloud/astro";
import cloudflare from "@distilled.cloud/astro/cloudflare";
import * as Options from "@distilled.cloud/e2e/Options";

export default Options.make({
  // Target-scoped config carriage: `target.cloudflare` carries the worker
  // config (dev/build) and the miniflare preview config.
  target: {
    cloudflare: {
      worker: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: {
          name: "fixtures-astro-static",
          bindings: [],
          assets: {
            htmlHandling: "auto-trailing-slash",
            notFoundHandling: "404-page",
          },
        },
      },
      // ASSETS-ONLY preview: a fully-static Astro build must deploy with no
      // user worker. Miniflare still requires a script, so — exactly like
      // fixtures/static-website — a stub 404 worker stands in behind
      // `has_user_worker: false`; every real request must be answered by the
      // asset layer (including the built 404.html via `not_found_handling:
      // "404-page"`). If a request ever reaches the stub, routing is wrong.
      preview: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        modules: [
          {
            type: "ESModule",
            path: "index.js",
            contents: `export default { fetch: () => new Response("stub worker reached — astro-static must be assets-only", { status: 500 }) }`,
          },
        ],
        assets: {
          binding: "ASSETS",
          routerConfig: {
            has_user_worker: false,
            invoke_user_worker_ahead_of_assets: false,
          },
          assetConfig: {
            html_handling: "auto-trailing-slash",
            not_found_handling: "404-page",
          },
        },
      },
    },
  },
  // Deliberately NO `astro:` overrides — this fixture's Astro configuration
  // lives in its real `astro.config.mjs` (`output: "static"`), which the
  // integration must load and honor (the user-config principle).
  framework: (options) =>
    Astro.make({
      target: cloudflare({ worker: Options.resolveCloudflareOptions(options).worker }),
    }),
});
