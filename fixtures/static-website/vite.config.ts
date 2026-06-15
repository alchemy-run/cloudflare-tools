import cloudflare from "@distilled.cloud/cloudflare-vite-plugin";
import { defineConfig } from "vite";

const config = defineConfig({
  plugins: [
    cloudflare({
      main: "./src/server.ts",
      compatibilityDate: "2025-09-27",
      worker: {
        name: "fixtures-static-website",
        assets: {
          notFoundHandling: "single-page-application",
        },
      },
    }),
  ],
});

export default config;
