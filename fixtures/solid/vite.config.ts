import cloudflare from "@distilled.cloud/cloudflare-vite-plugin";
import type { PluginOption } from "vite";
import { defineConfig } from "vite";

import { solidStart } from "@solidjs/start/config";

export default defineConfig({
  plugins: [
    solidStart(),
    // nitro({ preset: "cloudflare-module" }),
    cloudflare({ compatibilityFlags: ["nodejs_als"] }) as PluginOption,
  ],
});
