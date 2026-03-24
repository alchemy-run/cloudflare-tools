import * as Schema from "effect/Schema";

export const ModuleType = Schema.Literals([
  "ESModule",
  "Text",
  "Data",
  "CompiledWasm",
  "SourceMap",
]);
export type ModuleType = typeof ModuleType.Type;

export class Module extends Schema.Class<Module>("distilled-core/Module")({
  name: Schema.String,
  content: Schema.Uint8Array,
  hash: Schema.String,
  type: ModuleType,
}) {}

export const MODULE_TYPE_TO_CONTENT_TYPE: Record<ModuleType, string> = {
  ESModule: "application/javascript+module",
  CompiledWasm: "application/wasm",
  Text: "text/plain",
  Data: "application/octet-stream",
  SourceMap: "application/source-map",
};
