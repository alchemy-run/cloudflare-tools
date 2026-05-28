import type {
  CustomPluginOptions,
  ImportKind,
  LoadResult,
  PluginContext,
  ResolveIdResult,
} from "rolldown";
import { describe, expect, it } from "vitest";
import { cjsDefaultInteropPlugin } from "../src/plugins/cjs-default-interop.js";

// oxlint-disable-next-line no-control-regex
const VIRTUAL_PREFIX = "\0distilled:cjs-default-fix:";

interface MockContext {
  fs: { readFile: (path: string) => Promise<string> };
  resolve: (source: string) => Promise<{ id: string; external?: boolean } | null>;
}

function makeContext(options: {
  files?: Record<string, string>;
  resolved?: Record<string, { id: string; external?: boolean } | null>;
}): MockContext {
  const files = options.files ?? {};
  const resolved = options.resolved ?? {};
  return {
    fs: {
      readFile: async (path: string) => {
        if (path in files) return files[path];
        throw new Error(`ENOENT: ${path}`);
      },
    },
    resolve: async (source: string) => resolved[source] ?? null,
  };
}

type ResolveIdHandler = (
  this: PluginContext,
  source: string,
  importer: string | undefined,
  options: { kind: ImportKind; isEntry: boolean; custom?: CustomPluginOptions },
) => Promise<ResolveIdResult>;
type LoadHandler = (this: PluginContext, id: string) => Promise<LoadResult>;

function getHandlers() {
  const plugin = cjsDefaultInteropPlugin.rolldown({});
  const resolveId = (plugin.resolveId as { handler: ResolveIdHandler }).handler;
  const load = (plugin.load as { handler: LoadHandler }).handler;
  return { resolveId, load };
}

const TS_CJS_WITH_DEFAULT = `
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.removeInvalidUnicode = removeInvalidUnicode;
exports.isValidUnicode = isValidUnicode;
function removeInvalidUnicode(str) { return str; }
function isValidUnicode(str) { return true; }
function assertValidUnicode(str) { return str; }
exports.default = assertValidUnicode;
`;

const PLAIN_CJS_NO_DEFAULT = `
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.escapePostgresIdentifier = escapePostgresIdentifier;
function escapePostgresIdentifier(str) { return '"' + str + '"'; }
`;

const CJS_MODULE_EXPORTS_REASSIGNED = `
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function sql() {}
exports.default = sql;
module.exports = sql;
module.exports.default = sql;
module.exports.isSqlQuery = function () {};
`;

const CJS_OBJECT_DEFINE_PROPERTY_EXPORTS = `
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
Object.defineProperty(exports, "removeInvalidUnicode", { enumerable: true, get: function () { return foo; } });
Object.defineProperty(exports, "isValidUnicode", { enumerable: true, get: function () { return bar; } });
function assertValidUnicode(str) { return str; }
exports.default = assertValidUnicode;
`;

describe("cjs-default-interop", () => {
  describe("resolveId", () => {
    it("redirects TS-compiled CJS with __esModule and exports.default through the shim", async () => {
      const target = "/repo/node_modules/some-pkg/lib/index.js";
      const ctx = makeContext({
        files: { [target]: TS_CJS_WITH_DEFAULT },
        resolved: { "some-pkg": { id: target } },
      });
      const { resolveId } = getHandlers();

      const result = await resolveId.call(ctx as unknown as PluginContext, "some-pkg", undefined, {
        kind: "import-statement",
        isEntry: false,
      });

      expect(result).toEqual({ id: `${VIRTUAL_PREFIX}${target}` });
    });

    it("does not redirect CJS modules without exports.default", async () => {
      const target = "/repo/node_modules/escape-identifier/lib/index.js";
      const ctx = makeContext({
        files: { [target]: PLAIN_CJS_NO_DEFAULT },
        resolved: { "escape-identifier": { id: target } },
      });
      const { resolveId } = getHandlers();

      const result = await resolveId.call(
        ctx as unknown as PluginContext,
        "escape-identifier",
        undefined,
        { kind: "import-statement", isEntry: false },
      );

      expect(result).toEqual({ id: target });
    });

    it("does not redirect CJS modules that reassign module.exports to a function", async () => {
      const target = "/repo/node_modules/sql/lib/index.js";
      const ctx = makeContext({
        files: { [target]: CJS_MODULE_EXPORTS_REASSIGNED },
        resolved: { sql: { id: target } },
      });
      const { resolveId } = getHandlers();

      const result = await resolveId.call(ctx as unknown as PluginContext, "sql", undefined, {
        kind: "import-statement",
        isEntry: false,
      });

      expect(result).toEqual({ id: target });
    });

    it("ignores files outside node_modules", async () => {
      const target = "/repo/src/local.js";
      const ctx = makeContext({
        files: { [target]: TS_CJS_WITH_DEFAULT },
        resolved: { "./local": { id: target } },
      });
      const { resolveId } = getHandlers();

      const result = await resolveId.call(ctx as unknown as PluginContext, "./local", undefined, {
        kind: "import-statement",
        isEntry: false,
      });

      expect(result).toEqual({ id: target });
    });

    it("ignores non-JS files", async () => {
      const target = "/repo/node_modules/some-pkg/data.json";
      const ctx = makeContext({
        resolved: { "some-pkg/data.json": { id: target } },
      });
      const { resolveId } = getHandlers();

      const result = await resolveId.call(
        ctx as unknown as PluginContext,
        "some-pkg/data.json",
        undefined,
        { kind: "import-statement", isEntry: false },
      );

      expect(result).toEqual({ id: target });
    });

    it("ignores require-call import kinds (which already use CJS interop)", async () => {
      const target = "/repo/node_modules/some-pkg/lib/index.js";
      const ctx = makeContext({
        files: { [target]: TS_CJS_WITH_DEFAULT },
        resolved: { "some-pkg": { id: target } },
      });
      const { resolveId } = getHandlers();

      const result = await resolveId.call(ctx as unknown as PluginContext, "some-pkg", undefined, {
        kind: "require-call",
        isEntry: false,
      });

      expect(result).toBeUndefined();
    });

    it("ignores requests imported from inside the virtual shim", async () => {
      const target = "/repo/node_modules/some-pkg/lib/index.js";
      const ctx = makeContext({
        files: { [target]: TS_CJS_WITH_DEFAULT },
        resolved: { [target]: { id: target } },
      });
      const { resolveId } = getHandlers();

      const result = await resolveId.call(
        ctx as unknown as PluginContext,
        target,
        `${VIRTUAL_PREFIX}${target}`,
        { kind: "import-statement", isEntry: false },
      );

      expect(result).toBeUndefined();
    });

    it("ignores externalized resolutions", async () => {
      const target = "node:fs";
      const ctx = makeContext({
        resolved: { "node:fs": { id: target, external: true } },
      });
      const { resolveId } = getHandlers();

      const result = await resolveId.call(ctx as unknown as PluginContext, "node:fs", undefined, {
        kind: "import-statement",
        isEntry: false,
      });

      expect(result).toEqual({ id: target, external: true });
    });
  });

  describe("load", () => {
    it("emits an ESM shim that picks the Babel-style default and re-exports named exports", async () => {
      const target = "/repo/node_modules/some-pkg/lib/index.js";
      const ctx = makeContext({ files: { [target]: TS_CJS_WITH_DEFAULT } });
      const { load } = getHandlers();

      const shim = await load.call(ctx as unknown as PluginContext, `${VIRTUAL_PREFIX}${target}`);

      expect(shim).toBeTruthy();
      expect(shim).toContain(`import __cjs from ${JSON.stringify(target)};`);
      expect(shim).toContain(
        `import { removeInvalidUnicode as __removeInvalidUnicode } from ${JSON.stringify(target)};`,
      );
      expect(shim).toContain(
        `import { isValidUnicode as __isValidUnicode } from ${JSON.stringify(target)};`,
      );
      expect(shim).toContain(`"default" in __cjs`);
      expect(shim).toContain(`__cjs.__esModule === true`);
      expect(shim).toContain(`export default __resolved;`);
      expect(shim).toContain(`export const removeInvalidUnicode = __removeInvalidUnicode;`);
      expect(shim).toContain(`export const isValidUnicode = __isValidUnicode;`);
      expect(shim).not.toContain("export const default");
      expect(shim).not.toContain("export const __esModule");
    });

    it("recognizes Object.defineProperty-style named exports", async () => {
      const target = "/repo/node_modules/some-pkg/lib/index.js";
      const ctx = makeContext({ files: { [target]: CJS_OBJECT_DEFINE_PROPERTY_EXPORTS } });
      const { load } = getHandlers();

      const shim = await load.call(ctx as unknown as PluginContext, `${VIRTUAL_PREFIX}${target}`);

      expect(shim).toContain(`export const removeInvalidUnicode = __removeInvalidUnicode;`);
      expect(shim).toContain(`export const isValidUnicode = __isValidUnicode;`);
    });
  });
});
