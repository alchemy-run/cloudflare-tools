//#region src/lib/widgets.ts
var describeWidgets = (widgets) => `widgets-via-user-alias:${widgets.length}`;
//#endregion
//#region src/routes/widgets/+page.ts
/**
* A UNIVERSAL load (`+page.ts`). With `ssr = false` it runs exclusively in
* the browser — yet the `/api/widgets` endpoint it fetches runs server-side
* in the worker. That split (client-run load, server-run endpoint) is the
* point of this fixture.
*/
var load = async ({ fetch }) => {
	const payload = await (await fetch("/api/widgets")).json();
	return {
		...payload,
		description: describeWidgets(payload.widgets)
	};
};
//#endregion
export { load };
