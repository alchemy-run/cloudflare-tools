import { sanitizePath } from "#/sanitize-path";
import path from "node:path";
import { RolldownMagicString, type Plugin } from "rolldown";

const MODULE_RULES = [
  { type: "CompiledWasm", pattern: /\.wasm(\?module)?$/ },
  { type: "Data", pattern: /\.bin$/ },
  { type: "Text", pattern: /\.(txt|html|sql)$/ },
] as const;

const MODULE_REFERENCE_PATTERN = `__CLOUDFLARE_MODULE__(${MODULE_RULES.map((rule) => rule.type).join("|")})__(.*?)__CLOUDFLARE_MODULE__`;
const MODULE_REFERENCE_REGEX = new RegExp(MODULE_REFERENCE_PATTERN);
const MODULE_REFERENCE_GLOBAL_REGEX = new RegExp(MODULE_REFERENCE_PATTERN, "g");

export function makeAdditionalModulesPlugin(): Plugin {
  const additionalModulePaths = new Set<string>();

  return {
    name: "rolldown-plugin-cloudflare:additional-modules",
    // TODO: these are Vite options, not Rolldown
    // enforce: "pre",
    // applyToEnvironment(environment) {
    //   return environment.name === "development";
    // },
    // hotUpdate(options) {
    //   if (additionalModulePaths.has(options.file)) {
    //     void options.server.restart();
    //     return [];
    //   }
    // },
    resolveId: {
      filter: { id: MODULE_RULES.map((rule) => rule.pattern) },
      async handler(source, importer, options) {
        const resolved = await this.resolve(source, importer, options);
        if (!resolved) {
          return;
        }

        const rule = MODULE_RULES.find((rule) => rule.pattern.test(resolved.id));
        if (!rule) {
          return resolved;
        }

        const filePath = sanitizePath(resolved.id);
        additionalModulePaths.add(filePath);

        return {
          external: true,
          id: moduleReferenceId(rule.type, filePath),
        };
      },
    },
    renderChunk: {
      filter: { code: { include: MODULE_REFERENCE_REGEX } },
      async handler(code, chunk) {
        const matches = code.matchAll(MODULE_REFERENCE_GLOBAL_REGEX);
        let magicString: RolldownMagicString | undefined;
        for (const match of matches) {
          magicString ??= new RolldownMagicString(code);
          const [full, , id] = match;
          const source = await this.fs.readFile(id);
          const referenceId = this.emitFile({
            type: "asset",
            name: path.basename(id),
            source,
          });
          const fileName = this.getFileName(referenceId);
          const relativePath = path.relative(path.dirname(chunk.fileName), fileName);
          const importPath = relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
          magicString.update(match.index, match.index + full.length, importPath);
        }
        if (magicString) {
          return magicString;
        }
      },
    },
  };
}

function moduleReferenceId(type: "CompiledWasm" | "Data" | "Text", id: string) {
  return `__CLOUDFLARE_MODULE__${type}__${id}__CLOUDFLARE_MODULE__` as const;
}
