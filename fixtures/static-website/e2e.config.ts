import * as Options from "@distilled.cloud/e2e/Options";

// Target-scoped config carriage (the canonical form): `target.cloudflare`
// carries the worker config (dev/build) and the miniflare preview config.
// The deprecated top-level `vite`/`miniflare` aliases keep working for
// fixtures that still use them.
export default Options.make({
  target: {
    cloudflare: {
      worker: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: {
          name: "fixtures-static-website",
          bindings: [],
          assets: {
            htmlHandling: "auto-trailing-slash",
            notFoundHandling: "none",
          },
        },
      },
      preview: {
        modules: [
          {
            type: "ESModule",
            path: "index.js",
            contents: `export default { fetch: (request) => new Response("Not Found", { status: 404 }) }`,
          },
        ],
        assets: {
          routerConfig: {
            has_user_worker: false,
            invoke_user_worker_ahead_of_assets: false,
            debug: true,
          },
          assetConfig: {
            html_handling: "auto-trailing-slash",
            not_found_handling: "none",
            debug: true,
            has_static_routing: false,
          },
        },
      },
    },
  },
});
