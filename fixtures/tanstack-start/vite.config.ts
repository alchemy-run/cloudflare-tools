import { devtools } from "@tanstack/devtools-vite";
import { defineConfig } from "vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import fs from "fs";

const distilled = await import("@distilled.cloud/cloudflare-vite-plugin").then((m) => m.default);
const cloudflare = await import("@cloudflare/vite-plugin").then((m) => m.cloudflare);

const config = defineConfig({
  plugins: [
    // cloudflare({
    //   config: {
    //     main: "./src/entry-server.ts",
    //     compatibility_date: "2026-03-10",
    //     compatibility_flags: ["nodejs_compat"],
    //   },
    //   viteEnvironment: {
    //     name: "ssr",
    //   },
    // }),
    distilled({
      main: "./src/entry-server.ts",
      compatibilityDate: "2026-03-10",
      compatibilityFlags: ["nodejs_compat"],
    }),
    devtools(),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    {
      name: "what-are-my-environments",
      configResolved(config) {
        console.log(
          "plugins are",
          config.plugins.map((p) => p.name),
        );
        console.log("environments are", Object.keys(config.environments));
        fs.writeFileSync(
          "distilled-environments.json",
          JSON.stringify(config.environments, null, 2),
        );
        console.log("environment is", config.environments.ssr);
      },
    },
  ],
});

export default config;
