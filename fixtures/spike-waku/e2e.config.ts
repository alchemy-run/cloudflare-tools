import { Text } from "@distilled.cloud/cloudflare-runtime/bindings";
import * as Options from "@distilled.cloud/e2e/Options";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const wakuDir = path.dirname(require.resolve("waku/package.json"));

export default Options.make({
  vite: {
    // Mandatory: waku's rsc environment declares TWO rolldown inputs
    // (`index` + `build`) and the dev plugin asserts exactly one entry.
    // This is waku's own rsc entry — its default export is the adapter's
    // ExportedHandler (same module waku wires as the `index` input).
    main: path.join(wakuDir, "dist/lib/vite-entries/entry.server.js"),
    compatibilityDate: "2026-03-10",
    compatibilityFlags: ["nodejs_als"],
    viteEnvironments: { entry: "rsc", children: ["ssr"] },
    worker: {
      name: "fixtures-spike-waku",
      bindings: [Text.local("MAX_ITEMS", "10")],
      assets: {
        htmlHandling: "drop-trailing-slash",
        notFoundHandling: "none",
      },
    },
  },
  miniflare: {
    compatibilityDate: "2026-03-10",
    compatibilityFlags: ["nodejs_als"],
    bindings: { MAX_ITEMS: "10" },
    assets: {
      routerConfig: {
        has_user_worker: true,
        invoke_user_worker_ahead_of_assets: false,
        debug: true,
      },
      assetConfig: {
        html_handling: "drop-trailing-slash",
        not_found_handling: "none",
        debug: true,
        has_static_routing: false,
      },
    },
  },
});
