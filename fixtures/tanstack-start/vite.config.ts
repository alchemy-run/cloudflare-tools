import { Text } from "@distilled.cloud/cloudflare-runtime/bindings";
import cloudflare from "@distilled.cloud/cloudflare-vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import dotenv from "dotenv";
import { defineConfig } from "vite";

dotenv.config();

const config = defineConfig({
  plugins: [
    cloudflare({
      compatibilityDate: "2026-03-10",
      compatibilityFlags: ["nodejs_compat"],
      worker: {
        name: "fixtures-tanstack-start",
        bindings: [Text.local("TEST_POSTGRES_URL", process.env.TEST_POSTGRES_URL!)],
      },
    }),
    devtools(),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});

export default config;
