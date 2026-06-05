import { devtools } from "@tanstack/devtools-vite";
import dotenv from "dotenv";
import { defineConfig } from "vite";

// import { cloudflare } from "@cloudflare/vite-plugin";
import { Text } from "@distilled.cloud/cloudflare-runtime/bindings";
import distilled from "@distilled.cloud/cloudflare-vite-plugin";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";

dotenv.config();

const config = defineConfig({
  plugins: [
    // cloudflare({
    //   config: {
    //     compatibility_date: "2026-03-10",
    //     compatibility_flags: ["nodejs_compat"],
    //     main: "@tanstack/react-start/server-entry",
    //     vars: {
    //       TEST_POSTGRES_URL: process.env.TEST_POSTGRES_URL!,
    //     },
    //   },
    //   viteEnvironment: { name: "ssr" },
    // }),
    distilled({
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
