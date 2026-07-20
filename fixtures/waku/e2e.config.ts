import { Text } from "@distilled.cloud/cloudflare-runtime/bindings";
import * as Options from "@distilled.cloud/e2e/Options";
import wakuFramework from "@distilled.cloud/waku";

export default Options.make({
  vite: {
    // `main` and `viteEnvironments` are pinned by @distilled.cloud/waku
    // (waku's rsc entry + the rsc/ssr topology) — only worker config here.
    compatibilityDate: "2026-03-10",
    compatibilityFlags: ["nodejs_als"],
    worker: {
      name: "fixtures-waku",
      bindings: [Text.local("MESSAGE", "hello-from-binding")],
      assets: {
        htmlHandling: "drop-trailing-slash",
        notFoundHandling: "none",
      },
    },
  },
  miniflare: {
    compatibilityDate: "2026-03-10",
    compatibilityFlags: ["nodejs_als"],
    bindings: { MESSAGE: "hello-from-binding" },
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
  // The typed factory form so the fixture can pin its assigned dev port; the
  // string form (`framework: "@distilled.cloud/waku"`) is equivalent minus
  // the extra option.
  framework: (options) => wakuFramework({ ...options, port: 3101 }),
});
