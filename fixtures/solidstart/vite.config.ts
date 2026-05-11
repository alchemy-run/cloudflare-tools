import cloudflare from "@distilled.cloud/cloudflare-vite-plugin";
import { solidStart } from "@solidjs/start/config";
import type { PluginOption } from "vite";
import { defineConfig } from "vite";

import fs from "node:fs";

export default defineConfig({
  plugins: [
    solidStart(),
    cloudflare({ compatibilityFlags: ["nodejs_als", "pear"] }) as PluginOption,
    {
      name: "config",
      config(config) {
        fs.writeFileSync("config.json", JSON.stringify(config, null, 2));
      },
    },
  ],
  build: {
    rollupOptions: {
      external: ["cloudflare:workers"],
    },
  },
});
