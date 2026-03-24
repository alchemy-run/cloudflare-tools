import * as Schema from "effect/Schema";
import { Module, MODULE_TYPE_TO_CONTENT_TYPE } from "./Module.js";

export class Output extends Schema.Class<Output>("distilled-core/Output")({
  /** The absolute path to the output directory. */
  directory: Schema.String,
  /** The relative path to the main entry point. */
  main: Schema.String,
  /** All modules produced during bundling. */
  modules: Schema.Array(Module),
  /** The module format of the entry point. */
  format: Schema.Literal("esm"),
  /** The warnings produced during bundling. */
  warnings: Schema.Array(Schema.String),
}) {}

export declare namespace WorkerUploadPayload {
  interface PutScript {
    /* Name of the uploaded file that contains the main module. */
    main_module: string;
    files: Array<File>;
  }
  interface BetaVersion {
    main_module: string;
    modules: Array<{
      name: string;
      content_type: string;
      content_base64: string;
    }>;
  }
}

export const toWorkerBetaUploadPayload = (output: Output): WorkerUploadPayload.BetaVersion => {
  return {
    main_module: output.main,
    modules: output.modules.map((module) => ({
      name: module.name,
      content_type: MODULE_TYPE_TO_CONTENT_TYPE[module.type],
      content_base64: Buffer.from(module.content).toString("base64"),
    })),
  };
};

export const toWorkerPutScriptUploadPayload = (output: Output): WorkerUploadPayload.PutScript => {
  const files = output.modules.map(
    (module) =>
      new File([module.content], module.name, { type: MODULE_TYPE_TO_CONTENT_TYPE[module.type] }),
  );
  return {
    main_module: output.main,
    files,
  };
};
