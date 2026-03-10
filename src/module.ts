/**
 * A collected module (WASM, text, binary, etc.) that is part of the bundle output.
 */
export interface Module {
  /** Module name (relative path, possibly hashed) */
  readonly name: string;
  /** Absolute path to the source file */
  readonly path: string;
  /** Raw file content */
  readonly content: Buffer;
  /** The Cloudflare module type */
  readonly type: Module.Type;
}

export declare namespace Module {
  /**
   * Module types used in Cloudflare Worker uploads.
   */
  export type Type = "ESModule" | "CommonJS" | "CompiledWasm" | "Text" | "Data";
}
