import { devtools } from "@tanstack/devtools-vite";
import { defineConfig } from "vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";

const config = defineConfig({
  plugins: [
    // cloudflare({
    //   compatibilityDate: "2026-03-10",
    //   compatibilityFlags: ["nodejs_compat"],
    // }) as PluginOption,
    devtools(),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});

export default config;
