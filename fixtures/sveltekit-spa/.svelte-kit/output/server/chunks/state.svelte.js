import "./server2.js";
import { a as payload } from "./internal.js";
payload.base;
payload.assets;
//#endregion
//#region ../../node_modules/.bun/@sveltejs+kit@3.0.0-next.9+696059cbc04e5fbe/node_modules/@sveltejs/kit/src/runtime/client/state.svelte.js
var page = new class Page {
	data = {};
	form = null;
	error = null;
	params = {};
	route = { id: null };
	state = {};
	status = -1;
	url = new URL("a:");
}();
new class Navigating {
	/** @type {import('@sveltejs/kit').Navigation | null} */
	current = null;
}();
var updated = new class Updated {
	current = false;
	check = async () => false;
}();
//#endregion
export { updated as n, page as t };
