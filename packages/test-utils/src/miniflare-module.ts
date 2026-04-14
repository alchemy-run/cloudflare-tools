import fs from "node:fs/promises";
import path from "node:path";
import type { OutputAsset, OutputChunk } from "rolldown";

export interface MiniflareModule {
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

export function miniflareModulesFromRolldownOutput(
  output: Array<OutputChunk | OutputAsset>,
): Array<MiniflareModule> {
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

export async function miniflareModulesFromDirectory(
  dir: string,
  parent?: string,
): Promise<Array<MiniflareModule>> {
  const files = await fs.readdir(dir, { withFileTypes: true });
  const modules: Array<MiniflareModule> = [];
  await Promise.all(
    files.map(async (file) => {
      if (file.isFile()) {
        const type = moduleTypeFromExtension(path.extname(file.name));
        if (type === "SourceMap") {
          return;
        }
        modules.push({
          path: path.join(parent ?? "", file.name),
          type,
          contents: await fs.readFile(path.join(dir, file.name), "utf-8"),
        });
      } else if (file.isDirectory()) {
        modules.push(
          ...(await miniflareModulesFromDirectory(
            path.join(dir, file.name),
            path.join(parent ?? "", file.name),
          )),
        );
      }
    }),
  );
  // Sort by path length to ensure parent modules are loaded first
  return modules.sort((a, b) => a.path.length - b.path.length);
}

export function moduleTypeFromExtension(ext: string): MiniflareModule["type"] | "SourceMap" {
  switch (ext) {
    case ".wasm":
      return "CompiledWasm";
    case ".txt":
    case ".html":
    case ".css":
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
