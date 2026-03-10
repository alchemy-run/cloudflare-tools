/**
 * A collected module (WASM, text, binary, etc.) that is part of the bundle output.
 */
export interface CfModule {
	/** Module name (relative path, possibly hashed) */
	readonly name: string;
	/** Absolute path to the source file */
	readonly filePath: string;
	/** Raw file content */
	readonly content: Buffer | Uint8Array;
	/** The Cloudflare module type */
	readonly type: CfModuleType;
}

/**
 * Module types used in Cloudflare Worker uploads.
 */
export type CfModuleType =
	| "esm"
	| "commonjs"
	| "compiled-wasm"
	| "text"
	| "buffer";
