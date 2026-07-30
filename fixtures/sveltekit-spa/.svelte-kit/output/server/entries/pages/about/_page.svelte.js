import "../../../chunks/server2.js";
//#region src/routes/about/+page.svelte
function _page($$renderer) {
	$$renderer.push(`<h1 id="about-title">sveltekit-spa-about</h1> <p id="about-note">client-routed-about-page</p>`);
}
//#endregion
export { _page as default };
