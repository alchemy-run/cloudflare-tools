export const manifest = (() => {
function __memo(fn) {
	let value;
	return () => value ??= (value = fn());
}

return {
	appDir: "_app",
	appPath: "_app",
	assets: new Set(["robots.txt"]),
	mimeTypes: {".txt":"text/plain"},
	_: {
		client: {start:"_app/immutable/entry/start.B6OOocnE.js",app:"_app/immutable/entry/app.Dfog7lVP.js",imports:["_app/immutable/entry/start.B6OOocnE.js","_app/immutable/entry/payload.DSmR2FwN.js","_app/immutable/chunks/HclGiUj8.js","_app/immutable/chunks/Bp9lz7h_.js","_app/immutable/chunks/LSVETuk-.js","_app/immutable/chunks/BJBUZPiB.js","_app/immutable/entry/app.Dfog7lVP.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('../output/server/nodes/0.js')),
			__memo(() => import('../output/server/nodes/1.js')),
			__memo(() => import('../output/server/nodes/2.js')),
			__memo(() => import('../output/server/nodes/3.js')),
			__memo(() => import('../output/server/nodes/4.js'))
		],
		remotes: {
			
		},
		routes: [
			{
				id: "/",
				pattern: /^\/$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 2 },
				endpoint: null
			},
			{
				id: "/about",
				pattern: /^\/about\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 3 },
				endpoint: null
			},
			{
				id: "/api/widgets",
				pattern: /^\/api\/widgets\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('../output/server/entries/endpoints/api/widgets/_server.ts.js'))
			},
			{
				id: "/widgets",
				pattern: /^\/widgets\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 4 },
				endpoint: null
			}
		],
		prerendered_routes: new Set([]),
		matchers: async () => {
			return {};
		},
		server_assets: {}
	}
}
})();

export const prerendered = new Set([]);

export const base_path = "";
