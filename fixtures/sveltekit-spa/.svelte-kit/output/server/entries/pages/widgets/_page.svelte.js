import { F as attr, n as ensure_array_like, z as escape_html } from "../../../chunks/server2.js";
//#region src/routes/widgets/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		const { data } = $$props;
		$$renderer.push(`<h1 id="widgets-title">sveltekit-spa-widgets</h1> <p id="widgets-server">server:${escape_html(data.server ? "yes" : "no")}</p> <p id="widgets-message">message:${escape_html(data.message)}</p> <p id="widgets-description">${escape_html(data.description)}</p> <ul id="widgets-list"><!--[-->`);
		const each_array = ensure_array_like(data.widgets);
		for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
			let widget = each_array[$$index];
			$$renderer.push(`<li${attr("data-widget-id", widget.id)}>${escape_html(widget.name)}</li>`);
		}
		$$renderer.push(`<!--]--></ul>`);
	});
}
//#endregion
export { _page as default };
