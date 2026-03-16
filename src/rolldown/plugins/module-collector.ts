import type { Plugin } from "rolldown";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Module } from "../../module.js";
import { makeRuleFilters, parseRules, type Rule } from "../../module-rules.js";

export function createModuleCollector(options: {
  readonly rules?: ReadonlyArray<Rule>;
  readonly preserveFileNames?: boolean;
}) {
  const ruleFilters = makeRuleFilters(parseRules(options.rules));
  const preserveFileNames = options.preserveFileNames ?? false;
  let modules: Record<string, Module> = {};

  const plugin: Plugin = {
    name: "distilled-module-collector",
    buildStart() {
      modules = {};
    },
    async resolveId(source, importer, extraOptions) {
      const matched = ruleFilters.find(({ filters }) =>
        filters.some((f) => f.test(source)),
      );
      if (!matched || matched.rule.type === "ESModule" || matched.rule.type === "CommonJS") {
        return null;
      }

      const resolved =
        (await this.resolve(source, importer, {
          kind: extraOptions.kind,
          skipSelf: true,
        })) ?? null;

      const filePath =
        resolved?.id ??
        (importer ? path.resolve(path.dirname(importer), source) : path.resolve(source));

      const content = await readFile(filePath);
      const hash = crypto.createHash("sha1").update(content).digest("hex");
      const fileName = preserveFileNames
        ? path.basename(source)
        : `${hash}-${path.basename(source)}`;

      modules[fileName] = { name: fileName, path: filePath, content, type: matched.rule.type };

      this.addWatchFile(filePath);
      return { id: fileName, external: true };
    },
  };

  return { getModules: () => Object.values(modules), plugin };
}
