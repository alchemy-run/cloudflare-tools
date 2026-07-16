import { solidStart } from "@solidjs/start/config";
import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: { exclude: ["@solidjs/start"] },
  plugins: [solidStart()],
});
