import cloudflare from "@distilled.cloud/cloudflare-rolldown-plugin";
import * as Effect from "effect/Effect";
import path from "node:path";
import type { WorkerModule } from "../server.ts";
import type { BundleOutput } from "./bundle.vendor.ts";
import { build } from "./bundle.vendor.ts";

export function bundle(entry: string): Effect.Effect<BundleOutput> {
  return build({
    input: import.meta.resolve(`../../${entry}`, import.meta.url),
    plugins: [cloudflare()],
  }).pipe(Effect.orDie);
}

export function bundleOutputToWorkerd(bundle: BundleOutput): Effect.Effect<Array<WorkerModule>> {
  return Effect.sync(() => {
    const modules: Array<WorkerModule> = [];
    for (const file of bundle.files) {
      if (file.path.endsWith(".map") || file.content instanceof Uint8Array) {
        continue;
      }
      modules.push({
        name: file.path,
        esModule: file.content,
      });
    }
    return modules;
  });
}

export function bundleOutputToFiles(bundle: BundleOutput): Effect.Effect<[File, ...Array<File>]> {
  return Effect.forEach(bundle.files, (file) =>
    Effect.succeed(
      new File([file.content], file.path, {
        type: contentTypeFromExtension(path.extname(file.path)),
      }),
    ),
  );
}

function contentTypeFromExtension(extension: string): string {
  switch (extension) {
    case ".wasm":
      return "application/wasm";
    case ".txt":
    case ".html":
    case ".sql":
    case ".custom":
      return "text/plain";
    case ".bin":
      return "application/octet-stream";
    case ".mjs":
    case ".js":
      return "application/javascript+module";
    case ".cjs":
      return "application/javascript";
    case ".map":
      return "application/source-map";
    default:
      return "application/octet-stream";
  }
}
