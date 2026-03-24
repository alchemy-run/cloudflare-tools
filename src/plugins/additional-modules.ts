import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModuleType, Module as OutputModule } from "../core/Module.js";
import { Module } from "../core/Module.js";
import { hash } from "../core/Hash.js";
import {
  makeRuleFilters,
  parseRules,
  type Options as AdditionalModulesOptions,
} from "../core/AdditionalModules.js";
import type { OutputAsset, Plugin, RolldownOutput } from "rolldown";
import { createUnplugin } from "unplugin";

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
  readonly ruleFilters: ReturnType<typeof makeRuleFilters>;
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
  readonly rewrite: (
    output: RolldownOutput,
    directory: string,
  ) => Promise<ReadonlyArray<OutputModule>>;
} {
  const trackedModules = new Map<string, TrackedModule>();
  const preserveFileNames = options?.preserveFileNames ?? false;

  return {
    plugins: [
      additionalModules.rolldown({
        trackedModules,
        ruleFilters: makeRuleFilters(parseRules(options?.rules)),
      }) as Plugin,
    ],
    rewrite: async (output, directory) => {
      const modules: Array<OutputModule> = [];
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
