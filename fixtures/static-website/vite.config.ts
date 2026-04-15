import cloudflare from "@distilled.cloud/cloudflare-vite-plugin";
import { defineConfig } from "vite";

const config = defineConfig({
  plugins: [
    cloudflare({
      compatibilityDate: undefined,
      compatibilityFlags: undefined,
    }),
  ],
});

export default config;
