import { Text } from "@distilled.cloud/cloudflare-runtime/bindings";
import * as Options from "@distilled.cloud/e2e/Options";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export default Config.string("TEST_POSTGRES_URL").pipe(
  Config.orElse(() => Config.succeed("")),
  Effect.map((url) =>
    Options.make({
      vite: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: {
          name: "fixtures-tanstack-start",
          bindings: [Text.local("TEST_POSTGRES_URL", url)],
          assets: {
            runWorkerFirst: true,
            htmlHandling: "auto-trailing-slash",
            notFoundHandling: "none",
          },
        },
      },
      miniflare: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { TEST_POSTGRES_URL: url },
        assets: {
          routerConfig: {
            has_user_worker: true,
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
    }),
  ),
);
