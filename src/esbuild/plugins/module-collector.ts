import type { Plugin } from "esbuild";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Module } from "../../module.js";
import { makeRuleFilters, parseRules, type Rule } from "../../module-rules.js";

export function createModuleCollector(options: {
  readonly rules?: ReadonlyArray<Rule>;
  readonly preserveFileNames?: boolean;
}) {
  const rules = parseRules(options.rules);
  const ruleFilters = makeRuleFilters(rules);
  const preserveFileNames = options.preserveFileNames ?? false;
  let modules: Record<string, Module> = {};

  const plugin: Plugin = {
    name: "distilled-module-collector",
    setup(build) {
      build.onStart(() => {
        modules = {};
      });

      for (const rule of rules) {
        if (rule.type === "ESModule" || rule.type === "CommonJS") continue;
        for (const glob of rule.globs) {
          const filter = new RegExp(
            glob.replace(/\./g, "\\.").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*"),
          );
          build.onResolve({ filter }, async (args) => {
            if (args.pluginData?.skip) return undefined;

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

            const importPath = args.path;
            const matched = ruleFilters.find(({ filters }) =>
              filters.some((f) => f.test(importPath)),
            );
            if (!matched) return undefined;

            const content = await readFile(filePath);
            const hash = crypto.createHash("sha1").update(content).digest("hex");
            const fileName = preserveFileNames
              ? path.basename(importPath)
              : `${hash}-${path.basename(importPath)}`;

            modules[fileName] = { name: fileName, path: filePath, content, type: matched.rule.type };

            return { path: fileName, external: true, watchFiles: [filePath] };
          });
        }
      }
    },
  };

  return { getModules: () => Object.values(modules), plugin };
}
