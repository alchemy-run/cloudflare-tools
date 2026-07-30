import { z as escape_html } from "../../chunks/server2.js";
//#region src/routes/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		$$renderer.push(`<h1 id="home-title">sveltekit-spa-home</h1> <p id="hydrated">hydrated:${escape_html("no")}</p> <p id="svelte-config">marker:__SVELTE_CONFIG_MARKER__</p>`);
	});
}
//#endregion
export { _page as default };
