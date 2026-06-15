import cloudflare from "@distilled.cloud/cloudflare-vite-plugin";
import react from "@vitejs/plugin-react";
import rsc from "@vitejs/plugin-rsc";
import { defineConfig } from "vite";

// Same app as vite.config.ts but with the Cloudflare plugin registered BEFORE
// `rsc()`. This deliberately produces the non-conventional condition ordering
// (the rsc env's `resolve.conditions` lists workerd conditions before
// `react-server`). The plugin-order.test.ts boots this config to prove RSC dev
// resolves correctly regardless of plugin order — export-condition resolution
// is set-membership (React's own `exports` ordering decides), so `react-server`
// being present is what matters, not its index in the conditions array.
export default defineConfig({
  plugins: [
    cloudflare({
      main: "./src/framework/entry.rsc.tsx",
      compatibilityDate: "2026-03-10",
      compatibilityFlags: ["nodejs_compat"],
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      worker: { name: "fixtures-react-rsc-cf-first" },
    }),
    rsc({ serverHandler: false }),
    react(),
  ],

  environments: {
    rsc: {
      build: { rollupOptions: { input: { index: "./src/framework/entry.rsc.tsx" } } },
    },
    ssr: {
      build: { rollupOptions: { input: { index: "./src/framework/entry.ssr.tsx" } } },
    },
    client: {
      build: { rollupOptions: { input: { index: "./src/framework/entry.browser.tsx" } } },
    },
  },
});
