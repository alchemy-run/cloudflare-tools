//#region ../../node_modules/.bun/@sveltejs+kit@3.0.0-next.9+696059cbc04e5fbe/node_modules/@sveltejs/kit/src/runtime/client/payload.js
/** @import {SvelteKitPayload} from 'types'; */
/**
* Code inside the SvelteKit client runtime should only use this, not the global,
* so that the file hashes stay stable between rebuilds as long as the SvelteKit runtime doesn't change
*/
var payload = {};
//#endregion
//#region ../../node_modules/.bun/@sveltejs+kit@3.0.0-next.9+696059cbc04e5fbe/node_modules/@sveltejs/kit/src/runtime/app/env/internal.js
var version = "1785428260335";
var prerendering = false;
function set_building() {}
function set_prerendering() {
	prerendering = true;
}
//#endregion
export { payload as a, version as i, set_building as n, set_prerendering as r, prerendering as t };
