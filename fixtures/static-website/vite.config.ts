import cloudflare from "@distilled.cloud/cloudflare-vite-plugin";
import { defineConfig } from "vite";

const enableTestWorker = process.env.DISTILLED_STATIC_WEBSITE_WORKER === "1";

const config = defineConfig({
  plugins: [
    cloudflare(
      enableTestWorker
        ? {
            main: "./src/server.ts",
            compatibilityDate: "2025-09-27",
            worker: {
              name: "fixtures-static-website",
              assets: {
                notFoundHandling: "single-page-application",
              },
            },
          }
        : {},
    ),
  ],
});

export default config;
