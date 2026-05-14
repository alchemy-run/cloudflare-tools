import cloudflare from "@distilled.cloud/cloudflare-vite-plugin";
import devtools from "solid-devtools/vite";
import type { PluginOption } from "vite";
import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
  plugins: [
    devtools(),
    solidPlugin(),
    cloudflare({ compatibilityFlags: ["nodejs_als"] }) as PluginOption,
  ],
  server: {
    port: 3000,
  },
  build: {
    target: "esnext",
  },
});
