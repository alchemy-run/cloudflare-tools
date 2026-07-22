import { Text } from "@distilled.cloud/cloudflare-runtime/bindings";
import * as Options from "@distilled.cloud/e2e/Options";
import { kCurrentWorker } from "miniflare";

export default Options.make({
  // The Next.js (OpenNext-based) Framework implementation, resolved from this
  // fixture's own node_modules.
  framework: "@distilled.cloud/nextjs",
  vite: {
    compatibilityDate: "2026-05-12",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    worker: {
      name: "fixtures-nextjs",
      bindings: [Text.local("TEST_TEXT", "hello-from-binding")],
    },
  },
  miniflare: {
    name: "fixtures-nextjs",
    compatibilityDate: "2026-05-12",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    bindings: { TEST_TEXT: "hello-from-binding" },
    serviceBindings: { WORKER_SELF_REFERENCE: kCurrentWorker },
    durableObjects: {
      NEXT_CACHE_DO_QUEUE: { className: "DOQueueHandler", useSQLite: true },
    },
    assets: {
      binding: "ASSETS",
      routerConfig: {
        has_user_worker: true,
        invoke_user_worker_ahead_of_assets: true,
      },
      assetConfig: {
        html_handling: "none",
        not_found_handling: "none",
      },
    },
  },
});
