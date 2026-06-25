import cloudflare from "@distilled.cloud/cloudflare-vite-plugin";
import react from "@vitejs/plugin-react";
import rsc from "@vitejs/plugin-rsc";
import { defineConfig } from "vite";

// Minimal React Router app (hand-rolled on @vitejs/plugin-rsc) wired to the
// distilled Cloudflare vite plugin. The Worker IS the `rsc` environment; its
// fetch handler loads the `ssr` environment at runtime via
// `import.meta.viteRsc.loadModule("ssr", ...)`. The new `viteEnvironments`
// option declares this entry/child topology to the plugin.
export default defineConfig({
  plugins: [
    react(),
    rsc({
      serverHandler: false,
      entries: {
        client: "./react-router-vite/entry.browser.tsx",
        ssr: "./react-router-vite/entry.ssr.tsx",
        rsc: "./react-router-vite/entry.worker.tsx",
      },
    }),
    cloudflare({
      main: "./react-router-vite/entry.worker.tsx",
      compatibilityDate: "2026-03-10",
      compatibilityFlags: ["nodejs_compat"],
      viteEnvironments: { entry: "rsc", children: ["ssr"] },
      worker: { name: "fixtures-react-router-rsc", bindings: [] },
    }),
  ],
  optimizeDeps: {
    include: ["react-router", "react-router/internal/react-server-client"],
  },
});
