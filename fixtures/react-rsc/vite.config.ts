import cloudflare from "@distilled.cloud/cloudflare-vite-plugin";
import react from "@vitejs/plugin-react";
import rsc from "@vitejs/plugin-rsc";
import { defineConfig } from "vite";

// Minimal React Server Components app (the @vitejs/plugin-rsc `starter`)
// wired to the distilled Cloudflare vite plugin, to reproduce and then fix
// RSC dev support (cloudflare-tools#43).
//
// The worker IS the `rsc` environment: plugin-rsc resolves it with the
// `react-server` condition and its `default export` ({ fetch }) is the
// request handler. `serverHandler: false` tells plugin-rsc not to mount its
// own Node dev middleware, so requests route into workerd instead.
export default defineConfig({
  plugins: [
    cloudflare({
      main: "./src/framework/entry.rsc.tsx",
      compatibilityDate: "2026-03-10",
      compatibilityFlags: ["nodejs_compat"],
      // The Worker is the `rsc` environment; it loads `ssr` modules at runtime.
      viteEnvironments: { entry: "rsc", children: ["ssr"] },
      worker: { name: "fixtures-react-rsc", bindings: [] },
    }),
    rsc(),
    react(),
  ],

  environments: {
    rsc: {
      build: { rolldownOptions: { input: { index: "./src/framework/entry.rsc.tsx" } } },
    },
    ssr: {
      build: { rolldownOptions: { input: { index: "./src/framework/entry.ssr.tsx" } } },
    },
    client: {
      build: { rolldownOptions: { input: { index: "./src/framework/entry.browser.tsx" } } },
    },
  },
});
