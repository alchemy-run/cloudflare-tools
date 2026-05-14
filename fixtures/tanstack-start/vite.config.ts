import { devtools } from "@tanstack/devtools-vite";
import { defineConfig } from "vite";

import * as Service from "@distilled.cloud/cloudflare-runtime/bindings/Service";
import distilled from "@distilled.cloud/cloudflare-vite-plugin";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";

const config = defineConfig({
  plugins: [
    distilled({
      compatibilityDate: "2026-03-10",
      compatibilityFlags: ["nodejs_compat"],
      bindings: [Service.local({ name: "TEST", scriptName: "test" })],
    }),
    devtools(),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});

export default config;
