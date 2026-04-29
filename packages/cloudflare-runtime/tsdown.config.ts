import cloudflare from "@distilled.cloud/cloudflare-rolldown-plugin";
import { createRequire } from "node:module";
import path from "node:path";
import { RolldownMagicString, type OutputBundle, type OutputChunk, type Plugin } from "rolldown";
import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/**/*.worker.ts"],
    outDir: "dist/workers",
    tsconfig: "tsconfig.workers.json",
    format: "esm",
    plugins: [cloudflare({ compatibilityDate: "2026-03-10" }), workerExportsPlugin()],
  },
  {
    entry: ["src/**/*.ts", "!src/**/*.worker.ts", "!src/global.d.ts"],
    exports: {
      exclude: ["**/internal/**"],
    },
    outDir: "dist",
    tsconfig: "tsconfig.bundle.json",
    unbundle: true,
    dts: true,
    shims: false,
    target: "esnext",
    format: "esm",
    inputOptions: { makeAbsoluteExternalsRelative: true },
    outputOptions: {
      exports: "named",
    },
    plugins: [
      {
        name: "workers",
        resolveId: {
          filter: { id: /^worker:.*$/ },
          async handler(id, importer) {
            const require = createRequire(importer ?? import.meta.url);
            const specifier = id.slice(7);
            const absolutePath = require.resolve(specifier);
            const relativePathTs = path.relative(path.resolve("./src"), absolutePath);
            const relativePathMjs = relativePathTs.replace(/\.ts$/, ".mjs");
            const resolvedId = path.resolve("./dist/workers", relativePathMjs);
            return {
              id: resolvedId,
              external: "relative",
            };
          },
        },
      },
    ],
  },
]);

function workerExportsPlugin(): Plugin {
  const getChunks = (bundle: OutputBundle) => {
    const chunks = new Map<string, OutputChunk>();
    for (const [fileName, output] of Object.entries(bundle)) {
      if (output.type === "chunk") {
        chunks.set(fileName, output);
      }
    }
    return chunks;
  };

  const getImportedChunks = (chunk: OutputChunk, chunks: Map<string, OutputChunk>) => {
    const modules: Array<OutputChunk> = [];
    const seen = new Set<string>();

    const visit = (module: OutputChunk) => {
      for (const fileName of module.imports) {
        const imported = chunks.get(fileName);
        if (!imported || seen.has(fileName)) {
          continue;
        }
        seen.add(fileName);
        visit(imported);
        modules.push(imported);
      }
    };

    visit(chunk);
    return modules;
  };

  const getRelativeModulePath = (importer: string, imported: string) => {
    const relativePath = path.relative(path.dirname(importer), imported);
    return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
  };

  return {
    name: "distilled:worker-exports",
    generateBundle(_options, bundle) {
      const chunks = getChunks(bundle);

      for (const chunk of chunks.values()) {
        const magicString = new RolldownMagicString(chunk.code);
        const code = chunk.code;

        if (chunk.isEntry) {
          const modules = getImportedChunks(chunk, chunks);
          const imports = modules.map(
            (module, index) =>
              `import __workerModule${index} from ${JSON.stringify(
                getRelativeModulePath(chunk.fileName, module.fileName),
              )};`,
          );
          const moduleEntries = modules.map(
            (module, index) =>
              `  { name: ${JSON.stringify(module.fileName)}, type: "ESModule", content: __workerModule${index} },`,
          );

          magicString.update(
            0,
            code.length,
            [
              ...imports,
              imports.length > 0 ? "" : undefined,
              "export const modules = [",
              `  { name: ${JSON.stringify(chunk.fileName)}, type: "ESModule", content: ${JSON.stringify(
                code,
              )} },`,
              ...moduleEntries,
              "];",
              "",
            ]
              .filter((line) => line !== undefined)
              .join("\n"),
          );
        } else {
          magicString.update(0, code.length, `export default ${JSON.stringify(code)};\n`);
        }

        chunk.code = magicString.toString();
      }
    },
    async writeBundle(options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        const code =
          chunk.type === "chunk" && chunk.isEntry
            ? `import type { WorkerModule } from "../WorkerModule.mjs";\n\nexport const modules: [WorkerModule, ...WorkerModule[]];`
            : `declare const code: string;\nexport default code;\n`;
        await this.fs.writeFile(
          path.resolve(options.dir!, fileName.replace(/\.mjs$/, ".d.mts")),
          code,
        );
      }
    },
  };
}
