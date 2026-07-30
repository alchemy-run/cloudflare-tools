import "../../chunks/server2.js";
//#region src/routes/+layout.svelte
function _layout($$renderer, $$props) {
	const { children } = $$props;
	$$renderer.push(`<nav><a id="nav-home" href="/">home</a> <a id="nav-widgets" href="/widgets">widgets</a> <a id="nav-about" href="/about">about</a></nav> <main>`);
	children($$renderer);
	$$renderer.push(`<!----></main>`);
}
//#endregion
export { _layout as default };
