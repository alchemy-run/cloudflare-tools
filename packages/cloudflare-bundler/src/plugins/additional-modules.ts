import globToRegExp from "glob-to-regexp";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin, PluginContext } from "rolldown";
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
  referenceId?: string;
  fileName?: string;
  source?: Buffer;
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

const cleanResolvedId = (id: string) => id.split(/[?#]/, 1)[0] ?? id;
const normalizePathForFilter = (id: string) => cleanResolvedId(id).replaceAll("\\", "/");

const ensureTrackedModuleReference = async (
  plugin: PluginContext,
  tracked: TrackedModule,
  preserveFileNames: boolean,
) => {
  if (tracked.referenceId) {
    return tracked.referenceId;
  }

  const source = await readFile(tracked.absolutePath);
  tracked.source = source;
  tracked.referenceId = plugin.emitFile({
    type: "asset",
    ...(preserveFileNames
      ? { fileName: tracked.originalName }
      : { fileName: path.posix.join("assets", `${hash(source)}-${tracked.originalName}`) }),
    originalFileName: tracked.absolutePath,
    source,
  });
  return tracked.referenceId;
};

export function createAdditionalModulesPlugin(options: AdditionalModulesOptions | undefined): {
  readonly plugins: ReadonlyArray<Plugin>;
  readonly getModules: () => ReadonlyArray<Module>;
} {
  const trackedModules = new Map<string, TrackedModule>();
  const preserveFileNames = options?.preserveFileNames ?? false;
  let emittedModules: ReadonlyArray<Module> = [];

  const ruleFilters = parseRules(options?.rules).map((rule) => ({
    rule,
    filters: rule.globs.map((glob) => globToRegExp(glob)),
  }));

  return {
    plugins: [
      {
        name: "distilled-additional-modules",
        async resolveId(source, importer, extraOptions) {
          if (source.startsWith(MODULE_ID_PREFIX)) {
            return null;
          }

          const resolved = await this.resolve(source, importer, {
            kind: extraOptions.kind,
            isEntry: extraOptions.isEntry,
            skipSelf: true,
          });
          if (!resolved) {
            return null;
          }

          // Skip plugin-generated virtual modules like the wasm `?init` helper.
          // Additional modules should only classify real resolved asset paths.
          if (resolved.id.startsWith("\0")) {
            return resolved;
          }

          const matchedRule = ruleFilters.find(({ filters }) =>
            filters.some((filter) => filter.test(normalizePathForFilter(resolved.id))),
          )?.rule;
          if (!matchedRule) {
            return resolved;
          }

          const absolutePath = cleanResolvedId(resolved.id);
          const encodedId = `${MODULE_ID_PREFIX}${matchedRule.type}:${absolutePath}`;
          const tracked = trackedModules.get(encodedId) ?? {
            absolutePath,
            encodedId,
            originalName: path.basename(absolutePath),
            type: matchedRule.type,
          };
          trackedModules.set(encodedId, tracked);

          return {
            id: encodedId,
            external: true,
          };
        },
        async renderChunk(code, chunk) {
          let nextCode = code;
          let didChange = false;

          for (const tracked of trackedModules.values()) {
            if (!nextCode.includes(tracked.encodedId)) {
              continue;
            }

            const referenceId = await ensureTrackedModuleReference(
              this,
              tracked,
              preserveFileNames,
            );
            const emittedFileName = this.getFileName(referenceId);
            tracked.fileName = emittedFileName;

            const relativePath = path.posix.relative(
              path.posix.dirname(chunk.fileName),
              emittedFileName,
            );
            const specifier = relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
            nextCode = nextCode.split(tracked.encodedId).join(specifier);
            didChange = true;
          }

          if (didChange) {
            return nextCode;
          }
        },
        generateBundle() {
          emittedModules = Array.from(trackedModules.values()).flatMap((tracked) => {
            if (!tracked.fileName || !tracked.source) {
              return [];
            }

            return [
              new Module({
                name: tracked.fileName,
                content: tracked.source,
                hash: hash(tracked.source),
                type: tracked.type,
              }),
            ];
          });
        },
      },
    ],
    getModules: () => emittedModules,
  };
}
