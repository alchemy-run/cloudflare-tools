
// this file is generated — do not edit it


declare module "svelte/elements" {
	export interface HTMLAttributes<T> {
		'data-sveltekit-keepfocus'?: true | false | '' | undefined | null;
		'data-sveltekit-noscroll'?: true | false | '' | undefined | null;
		'data-sveltekit-preload-code'?:
			| true
			| false
			| ''
			| 'eager'
			| 'viewport'
			| 'hover'
			| 'tap'
			| undefined
			| null;
		'data-sveltekit-preload-data'?: true | false | '' | 'hover' | 'tap' | undefined | null;
		'data-sveltekit-reload'?: true | false | '' | undefined | null;
		'data-sveltekit-replacestate'?: true | false | '' | undefined | null;
	}
}

export {};


declare module "$app/types" {
	export interface AppTypes {
		RouteId(): "/" | "/about" | "/api" | "/api/widgets" | "/widgets";
		RouteParams(): {
			
		};
		LayoutParams(): {
			"/": Record<string, never>;
			"/about": Record<string, never>;
			"/api": Record<string, never>;
			"/api/widgets": Record<string, never>;
			"/widgets": Record<string, never>
		};
		Pathname(): "/" | "/about" | "/api/widgets" | "/widgets";
		ResolvedPathname(): `${"" | `/${string}`}${ReturnType<AppTypes['Pathname']>}`;
		Asset(): "/robots.txt" | string & {};
	}
}