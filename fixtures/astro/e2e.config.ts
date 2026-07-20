import * as Astro from "@distilled.cloud/astro";
import { Assets, Text } from "@distilled.cloud/cloudflare-runtime/bindings";
import * as Options from "@distilled.cloud/e2e/Options";

export const FIXTURE_VALUE = "hello-from-astro-binding";

export default Options.make({
  vite: {
    compatibilityDate: "2026-03-10",
    compatibilityFlags: ["nodejs_compat"],
    worker: {
      name: "fixtures-astro",
      bindings: [Assets.local("ASSETS"), Text.local("FIXTURE_VALUE", FIXTURE_VALUE)],
      assets: {
        htmlHandling: "auto-trailing-slash",
        notFoundHandling: "none",
      },
    },
  },
  // The typed factory form: reuse the shared cloudflare worker options and add
  // astro-specific config (the dev toolbar would differ between dev and the
  // built output, breaking the shared screenshots).
  framework: (options) =>
    Astro.make({
      vite: options.vite,
      astro: { devToolbar: { enabled: false } },
    }),
  miniflare: {
    compatibilityDate: "2026-03-10",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { FIXTURE_VALUE },
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
});
