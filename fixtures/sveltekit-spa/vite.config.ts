/**
 * A REAL user-owned Vite config, exactly like a normal SvelteKit v3 project:
 * the user registers `sveltekit()` here themselves (kit v3 keeps all kit
 * options in this call), and `@distilled.cloud/sveltekit` must load this file
 * natively and inject its deploy-target adapter into THIS `sveltekit(...)`
 * instance rather than constructing a second one (the user-config
 * principle).
 *
 * Observable proof the file is honored:
 *
 * - `alias: { $spa: "src/lib" }` — a user kit alias imported by the widgets
 *   page; the route only compiles/loads if the user's `sveltekit()` call is
 *   the one that runs.
 */
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    sveltekit({
      alias: { $spa: "src/lib" },
    }),
  ],
});
