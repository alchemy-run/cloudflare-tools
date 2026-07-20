/**
 * Programmatic SvelteKit build with an in-memory adapter — no vite.config.ts,
 * no svelte.config.js, no wrangler.json.
 */
import { sveltekit } from "@sveltejs/kit/vite";
import path from "node:path";
import * as vite from "vite";
import { result, spikeCloudflareAdapter } from "./adapter.ts";

const root = path.resolve(import.meta.dirname, "..");
// kit resolves peers (`vite`, `@sveltejs/vite-plugin-svelte`) relative to cwd
process.chdir(root);

const plugins = await sveltekit({
  adapter: spikeCloudflareAdapter(),
});

const builder = await vite.createBuilder(
  {
    root,
    configFile: false,
    logLevel: "info",
    plugins: [plugins],
  },
  null,
);

await builder.buildApp();

if (!result.current) {
  throw new Error("adapter did not run");
}
console.log("[spike] adapter output:", result.current);
