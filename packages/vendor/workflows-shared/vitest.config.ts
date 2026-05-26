import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              compatibilityFlags: ["service_binding_extra_handlers"],
            },
            wrangler: {
              configPath: "./src/workers/workflows-shared/wrangler.jsonc",
            },
          }),
        ],
        test: {
          name: "workflows-shared",
          include: ["src/workers/workflows-shared/tests/**/*.test.ts"],
          testTimeout: 50_000,
        },
      },
    ],
  },
});
