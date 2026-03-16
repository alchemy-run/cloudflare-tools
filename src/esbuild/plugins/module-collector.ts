/**
 * esbuild plugin that collects non-JS modules (WASM, text, binary).
 */
import type { Plugin } from "esbuild";
import globToRegExp from "glob-to-regexp";
import path from "node:path";
import { ModuleCollectorCore, type ModuleCollectorOptions } from "../../module-collector.js";
import { parseRules } from "../../module-rules.js";

export function createModuleCollector(options: ModuleCollectorOptions = {}) {
  const core = new ModuleCollectorCore(options);
  const rules = parseRules(options.rules);

  const plugin: Plugin = {
    name: "distilled-module-collector",
    setup(build) {
      build.onStart(() => {
        core.reset();
      });

      for (const rule of rules) {
        if (rule.type === "ESModule" || rule.type === "CommonJS") {
          continue;
        }

        for (const glob of rule.globs) {
          build.onResolve({ filter: globToRegExp(glob) }, async (args) => {
            if (args.pluginData?.skip) {
              return undefined;
            }

            let filePath: string;
            try {
              const resolved = await build.resolve(args.path, {
                resolveDir: args.resolveDir,
                kind: args.kind,
                pluginData: { skip: true },
              });
              filePath = resolved.path;
            } catch {
              filePath = path.resolve(args.resolveDir, args.path);
            }

            const module = await core.resolve(filePath, args.path);
            if (module === null) {
              return undefined;
            }

            return {
              path: module.fileName,
              external: true,
              watchFiles: [filePath],
            };
          });
        }
      }
    },
  };

  return { getModules: () => core.getModules(), plugin };
}
