import type { Plugin } from "esbuild";

/**
 * esbuild plugin that marks `node:*` imports as external and emits warnings
 * when `nodejs_compat` is NOT enabled.
 */
export const nodejsCompatWarningPlugin: Plugin = {
  name: "distilled-nodejs-compat-warning",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => {
      return {
        path: args.path,
        external: true,
      };
    });

    build.onEnd((result) => {
      if (!result.metafile) return;
      const nodeImports = new Set<string>();
      for (const output of Object.values(result.metafile.outputs)) {
        for (const imp of output.imports) {
          if (imp.path.startsWith("node:")) {
            nodeImports.add(imp.path);
          }
        }
      }
      if (nodeImports.size > 0) {
        for (const imp of nodeImports) {
          result.warnings.push({
            id: "",
            pluginName: "distilled-nodejs-compat-warning",
            text:
              `The package "${imp}" wasn't found on the file system but is built into node. ` +
              `Your Worker may throw errors at runtime unless you enable the "nodejs_compat" compatibility flag. ` +
              `Refer to https://developers.cloudflare.com/workers/runtime-apis/nodejs/ for more details.`,
            notes: [],
            location: null,
            detail: undefined,
          });
        }
      }
    });
  },
};
