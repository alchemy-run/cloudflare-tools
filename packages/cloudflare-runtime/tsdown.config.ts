import {
  InternalWorkerExportPlugin,
  InternalWorkerImportPlugin,
} from "@distilled.cloud/build-utils";
import cloudflare from "@distilled.cloud/cloudflare-rolldown-plugin";
import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/**/*.worker.ts"],
    outDir: "dist/workers",
    tsconfig: "tsconfig.workers.json",
    format: "esm",
    minify: {
      mangle: false,
    },
    target: "esnext",
    dts: false,
    plugins: [cloudflare({ compatibilityDate: "2026-03-10" }), InternalWorkerExportPlugin()],
    deps: {
      alwaysBundle: [/.+/],
    },
    outputOptions: {
      entryFileNames: "[name].mjs",
    },
  },
  {
    entry: ["src/**/*.ts", "!src/**/*.worker.ts", "!src/global.d.ts"],
    exports: {
      exclude: ["**/internal/**", "**/*.worker.ts"],
      customExports: (exports) =>
        Object.fromEntries(
          Object.entries(exports).map(([key, value]) => [key.replace(".shared", ""), value]),
        ),
    },
    outDir: "dist/node",
    tsconfig: "tsconfig.node.json",
    unbundle: true,
    dts: true,
    shims: false,
    target: "esnext",
    format: "esm",
    inputOptions: { makeAbsoluteExternalsRelative: true },
    outputOptions: {
      entryFileNames: (chunkInfo) => {
        const name = chunkInfo.name.replace(
          /(^node_modules\/.+\/node_modules\/)|(^packages\/vendor\/)/,
          "vendor/",
        );
        return `${name}.${name.endsWith(".d") ? "mts" : "mjs"}`;
      },
    },
    plugins: [InternalWorkerImportPlugin()],
  },
]);
