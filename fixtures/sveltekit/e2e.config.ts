import { Text } from "@distilled.cloud/cloudflare-runtime/bindings";
import * as Options from "@distilled.cloud/e2e/Options";
import * as SvelteKit from "@distilled.cloud/sveltekit";

const SECRET = "s3cret-from-binding";

export default Options.make({
  // The typed factory form (harness contract form 3): map the harness
  // options onto SvelteKit options, then pin the dev port so parallel fixture
  // runs don't collide. `framework: "@distilled.cloud/sveltekit"` (the string
  // form) works identically when no framework-specific options are needed.
  // The deploy target defaults to `@distilled.cloud/sveltekit/cloudflare`.
  framework: (options) => {
    const base = SvelteKit.fromHarnessOptions(options as SvelteKit.HarnessOptions);
    return SvelteKit.layer({ ...base, dev: { ...base.dev, port: 3103 } });
  },
  // Target-scoped config carriage: `target.cloudflare.worker` is what the
  // framework package reads (compat date/flags, bindings, assets behavior);
  // `target.cloudflare.preview` configures the miniflare preview server the
  // harness's cloudflare target serves built output with.
  target: {
    cloudflare: {
      worker: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: {
          name: "fixtures-sveltekit",
          bindings: [Text.local("FIXTURE_SECRET", SECRET)],
          assets: {
            htmlHandling: "auto-trailing-slash",
            notFoundHandling: "none",
            runWorkerFirst: false,
          },
        },
      },
      preview: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { FIXTURE_SECRET: SECRET },
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
