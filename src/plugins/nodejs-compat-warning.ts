import type { Plugin } from "esbuild";

/**
 * Determines whether `navigator.userAgent` should be defined as `"Cloudflare-Workers"`.
 *
 * Wrangler enables this define for compatibility dates >= 2022-03-21.
 * See: https://developers.cloudflare.com/workers/configuration/compatibility-dates/#global-navigator
 */
/**
 * esbuild plugin that marks `node:*` imports as external and emits warnings
 * when `nodejs_compat` is NOT enabled.
 *
 * This matches wrangler's behavior: the build succeeds but the user is warned
 * that runtime errors may occur without the compatibility flag.
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
      // Check if any node: imports were externalized by looking at the metafile
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
