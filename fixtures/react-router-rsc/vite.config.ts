import cloudflare from "@distilled.cloud/cloudflare-vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import rsc from "@vitejs/plugin-rsc"
import { defineConfig } from "vite"

// React Router (hand-rolled on @vitejs/plugin-rsc) wired to the distilled
// Cloudflare vite plugin via the single-worker child-environment model —
// the same topology vermittelbar uses with the official plugin
// (`viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] }`). The worker
// IS the `rsc` env; its handler loads `ssr` at runtime via
// `import.meta.viteRsc.loadModule("ssr", ...)`.
export default defineConfig({
  clearScreen: false,
  build: { minify: false },
  plugins: [
    tailwindcss(),
    {
      // Workaround for https://github.com/tailwindlabs/tailwindcss/pull/19670
      name: "fix-tailwind-full-reload",
      configResolved(config) {
        const plugin = config.plugins.find(
          (p) => p.name === "@tailwindcss/vite:generate:serve",
        )
        delete plugin?.hotUpdate
      },
    },
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
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      worker: { name: "fixtures-react-router-rsc" },
    }),
  ],
  optimizeDeps: {
    include: ["react-router", "react-router/internal/react-server-client"],
  },
})
