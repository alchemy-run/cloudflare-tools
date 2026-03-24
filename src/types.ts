/**
 * Build output types.
 *
 * These types describe what a bundle operation produces. They are
 * bundler-agnostic — the same `BuildResult` is returned whether
 * you used esbuild, Rolldown, or any other bundler.
 *
 * @module
 */

/**
 * Module types recognized by the Workers runtime for multipart upload.
 */
export type ModuleType = "ESModule" | "CommonJS" | "Text" | "Data" | "CompiledWasm";

/**
 * A non-JS module included in the bundle output (WASM, text, binary data, etc.).
 */
export interface AdditionalModule {
  /** Filename of the module (e.g. "abc123-data.wasm") */
  readonly name: string;
  /** Workers module type */
  readonly type: ModuleType;
  /** File content — text for Text/ESModule/CommonJS, binary for Data/CompiledWasm */
  readonly content: string | Uint8Array;
}

/**
 * The result of a successful bundle operation.
 *
 * Contains everything a deployment tool needs to upload a Worker:
 * the bundled entry, additional modules, and optional source map.
 */
export interface BuildResult {
  /** Filename of the bundled entry module (e.g. "index.js") */
  readonly entryPoint: string;
  /** Bundled entry source code */
  readonly code: string | Uint8Array;
  /** Additional non-JS modules (WASM, text, data) */
  readonly additionalModules: ReadonlyArray<AdditionalModule>;
  /** Source map content, if generated */
  readonly sourceMap?: string;
}

/**
 * Error produced when a bundle operation fails.
 */
export interface BuildError {
  readonly _tag: "BuildError";
  readonly message: string;
  readonly errors?: ReadonlyArray<{
    readonly text: string;
    readonly location?: {
      readonly file: string;
      readonly line: number;
      readonly column: number;
    };
  }>;
}

/**
 * Create a `BuildError`.
 */
export function buildError(
  message: string,
  errors?: BuildError["errors"],
): BuildError {
  return { _tag: "BuildError", message, errors };
}
