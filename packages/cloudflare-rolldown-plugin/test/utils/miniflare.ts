import type { MiniflareOptions } from "miniflare";
import { Miniflare } from "miniflare";
import path from "node:path";
import type { OutputAsset, OutputChunk, RolldownOutput } from "rolldown";

export async function createMiniflare(
  output: RolldownOutput,
  options: MiniflareOptions = {},
): Promise<Miniflare & { [Symbol.asyncDispose]: () => Promise<void> }> {
  const miniflare = new Miniflare({
    modules: formatModules(output.output),
    ...options,
  });
  await miniflare.ready;
  return Object.assign(miniflare, { [Symbol.asyncDispose]: () => miniflare.dispose() });
}

interface Module {
  path: string;
  type:
    | "ESModule"
    | "CommonJS"
    | "Text"
    | "Data"
    | "CompiledWasm"
    | "PythonModule"
    | "PythonRequirement";
  contents?: string | Uint8Array<ArrayBuffer> | undefined;
}

function formatModules(output: Array<OutputChunk | OutputAsset>): Array<Module> {
  return output.flatMap((item) => {
    const type = moduleTypeFromExtension(path.extname(item.fileName));
    const contents =
      item.type === "chunk" ? item.code : (item.source as string | Uint8Array<ArrayBuffer>);
    if (type === "SourceMap") {
      return [];
    }
    return {
      path: item.fileName,
      type,
      contents,
    };
  });
}

function moduleTypeFromExtension(ext: string): Module["type"] | "SourceMap" {
  switch (ext) {
    case ".wasm":
      return "CompiledWasm";
    case ".txt":
    case ".html":
    case ".sql":
    case ".custom":
      return "Text";
    case ".bin":
      return "Data";
    case ".mjs":
    case ".js":
      return "ESModule";
    case ".cjs":
      return "CommonJS";
    case ".map":
      return "SourceMap";
    default:
      throw new Error(`Unknown extension: ${ext}`);
  }
}
