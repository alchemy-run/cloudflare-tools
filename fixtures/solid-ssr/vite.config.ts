import devtools from "solid-devtools/vite";
import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
  plugins: [devtools(), solidPlugin()],
  optimizeDeps: {
    // Injected by the devtools plugin, so the dependency scanner can't see it.
    // Without this, it is discovered on the first page load and triggers a
    // full-page reload mid-test ("optimized dependencies changed. reloading").
    include: ["solid-devtools/setup"],
  },
  server: {
    port: 3000,
  },
  build: {
    target: "esnext",
  },
});
