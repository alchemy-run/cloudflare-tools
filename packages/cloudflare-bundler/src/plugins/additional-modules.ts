import globToRegExp from "glob-to-regexp";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OutputAsset, Plugin, RolldownOutput } from "rolldown";
import { createUnplugin } from "unplugin";
import { hash } from "../hash.js";
import type { AdditionalModuleRule, AdditionalModulesOptions } from "../Input.js";
import type { ModuleType } from "../Module.js";
import { Module } from "../Module.js";

const MODULE_ID_PREFIX = "__DISTILLED_CLOUDFLARE_MODULE__:";

interface TrackedModule {
  readonly absolutePath: string;
  readonly encodedId: string;
  readonly originalName: string;
  readonly type: ModuleType;
  fileName?: string;
}

interface AdditionalModulesPluginOptions {
  readonly trackedModules: Map<string, TrackedModule>;
  readonly ruleFilters: ReadonlyArray<{
    readonly rule: AdditionalModuleRule;
    readonly filters: ReadonlyArray<RegExp>;
  }>;
}

const DEFAULT_MODULE_RULES: Array<AdditionalModuleRule> = [
  { type: "Text", globs: ["**/*.txt", "**/*.html", "**/*.sql"] },
  { type: "Data", globs: ["**/*.bin"] },
  { type: "CompiledWasm", globs: ["**/*.wasm", "**/*.wasm?module"] },
];

function parseRules(
  userRules: ReadonlyArray<AdditionalModuleRule> = [],
): ReadonlyArray<AdditionalModuleRule> {
  const rules: Array<AdditionalModuleRule> = [...userRules, ...DEFAULT_MODULE_RULES];

  const completedRuleLocations: Record<string, number> = {};
  const rulesToRemove: Array<AdditionalModuleRule> = [];
  let index = 0;

  for (const rule of rules) {
    if (rule.type in completedRuleLocations) {
      rulesToRemove.push(rule);
    }
    if (!(rule.type in completedRuleLocations) && rule.fallthrough !== true) {
      completedRuleLocations[rule.type] = index;
    }
    index++;
  }

  for (const rule of rulesToRemove) {
    const idx = rules.indexOf(rule);
    if (idx !== -1) {
      rules.splice(idx, 1);
    }
  }

  return rules;
}

const additionalModules = createUnplugin<AdditionalModulesPluginOptions>((options) => ({
  name: "distilled-additional-modules",
  resolveId(source, importer) {
    const matchedRule = options.ruleFilters.find(({ filters }) =>
      filters.some((filter) => filter.test(source)),
    )?.rule;
    if (!matchedRule) {
      return null;
    }

    const absolutePath = (
      importer && source.startsWith(".")
        ? path.resolve(path.dirname(importer), source)
        : path.resolve(source)
    ).split("?")[0]!;
    const encodedId = `${MODULE_ID_PREFIX}${matchedRule.type}:${absolutePath}`;
    const tracked = options.trackedModules.get(encodedId) ?? {
      absolutePath,
      encodedId,
      originalName: path.basename(absolutePath),
      type: matchedRule.type,
    };
    options.trackedModules.set(encodedId, tracked);
    this.addWatchFile(absolutePath);
    return {
      id: encodedId,
      external: true,
    };
  },
}));

export function createAdditionalModulesPlugin(options: AdditionalModulesOptions | undefined): {
  readonly plugins: ReadonlyArray<Plugin>;
  readonly rewrite: (output: RolldownOutput, directory: string) => Promise<ReadonlyArray<Module>>;
} {
  const trackedModules = new Map<string, TrackedModule>();
  const preserveFileNames = options?.preserveFileNames ?? false;

  const ruleFilters = parseRules(options?.rules).map((rule) => ({
    rule,
    filters: rule.globs.map((glob) => globToRegExp(glob)),
  }));

  return {
    plugins: [
      additionalModules.rolldown({
        trackedModules,
        ruleFilters,
      }) as Plugin,
    ],
    rewrite: async (output, directory) => {
      const modules: Array<Module> = [];
      const assets = new Map<string, TrackedModule>();

      for (const tracked of trackedModules.values()) {
        const content = await readFile(tracked.absolutePath);
        const fileName = preserveFileNames
          ? tracked.originalName
          : path.posix.join("assets", `${hash(content)}-${tracked.originalName}`);
        tracked.fileName = fileName;
        assets.set(fileName, tracked);

        const target = path.resolve(directory, fileName);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);

        modules.push(
          new Module({
            name: fileName,
            content,
            hash: hash(content),
            type: tracked.type,
          }),
        );
      }

      for (const item of output.output) {
        if (item.type !== "chunk") {
          continue;
        }

        let nextCode = item.code;
        for (const tracked of trackedModules.values()) {
          if (!tracked.fileName || !nextCode.includes(tracked.encodedId)) {
            continue;
          }

          const relativePath = path.posix.relative(
            path.posix.dirname(item.fileName),
            tracked.fileName,
          );
          const specifier = relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
          nextCode = nextCode.split(tracked.encodedId).join(specifier);
        }

        if (nextCode !== item.code) {
          await writeFile(path.resolve(directory, item.fileName), nextCode);
        }
      }

      return modules;
    },
  };
}

export const isSourceMapAsset = (asset: OutputAsset) => asset.fileName.endsWith(".map");
