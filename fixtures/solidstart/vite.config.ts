import cloudflare from "@distilled.cloud/cloudflare-vite-plugin";
import { solidStart } from "@solidjs/start/config";
import type { PluginOption } from "vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    solidStart(),
    cloudflare({ compatibilityFlags: ["nodejs_als"], exports: ["default"] }) as PluginOption,
  ],
});
