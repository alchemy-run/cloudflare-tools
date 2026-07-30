/**
 * A REAL user-owned `svelte.config.js`. In SvelteKit v3 the kit options live
 * in the `sveltekit(...)` call in `vite.config.ts`, but
 * `@sveltejs/vite-plugin-svelte` still loads this file for Svelte compiler
 * options and preprocessors — so honoring it is part of the user-config
 * principle.
 *
 * Observable proof the file is honored: the `markerPreprocessor` below
 * rewrites the literal `__SVELTE_CONFIG_MARKER__` (rendered by the home
 * page) to `svelte-config-loaded`. The smoke test asserts the replaced
 * value, which only appears if this file was actually loaded.
 */

/** @type {import("svelte/compiler").PreprocessorGroup} */
const markerPreprocessor = {
  name: "fixture-svelte-config-marker",
  markup({ content }) {
    if (!content.includes("__SVELTE_CONFIG_MARKER__")) return undefined;
    return { code: content.replaceAll("__SVELTE_CONFIG_MARKER__", "svelte-config-loaded") };
  },
};

/** @type {import("@sveltejs/vite-plugin-svelte").SvelteConfig} */
export default {
  preprocess: [markerPreprocessor],
};
