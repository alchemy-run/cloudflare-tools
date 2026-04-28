import cloudflare from "@distilled.cloud/cloudflare-rolldown-plugin";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/**/*.ts", "!src/**/*.worker.ts"],
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
    plugins: [
      {
        name: "workers",
        resolveId: {
          filter: { id: /^worker:.*$/ },
          async handler(id, importer) {
            const require = createRequire(importer ?? import.meta.url);
            const resolvedId = require.resolve(id.slice(7));
            const relativeId = path.relative(path.resolve("./src"), resolvedId);
            return {
              id: `worker:${relativeId}`,
            };
          },
        },
        load: {
          filter: { id: /^worker:.*$/ },
          async handler(id) {
            const input = fileURLToPath(
              import.meta.resolve(`./src/${id.slice(7)}`, import.meta.url),
            );
            await using bundle = await rolldown({
              input,
              plugins: [cloudflare({ compatibilityDate: "2026-03-10" })],
            });
            const result = await bundle.generate({ format: "esm" });
            return {
              code: `export const name: string = "${result.output[0].fileName}";
export const code: string = ${JSON.stringify(result.output[0].code)};`,
              moduleType: "ts",
            };
          },
        },
      },
    ],
  },
]);
