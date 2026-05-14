import cloudflare from "@distilled.cloud/cloudflare-vite-plugin";
import { defineConfig } from "vite";

const config = defineConfig({
  plugins: [cloudflare({})],
});

export default config;
