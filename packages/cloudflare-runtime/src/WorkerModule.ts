import type * as Config from "./workerd/Config.ts";

export type WorkerModule =
  | {
      name: string;
      type: "ESModule" | "CommonJsModule" | "Text" | "Json" | "PythonModule" | "PythonRequirement";
      content: string;
    }
  | {
      name: string;
      type: "Data" | "Wasm";
      content: Uint8Array;
    };

export const toWorkerd = (module: WorkerModule): Config.Worker_Module => {
  switch (module.type) {
    case "ESModule":
      return { name: module.name, esModule: module.content };
    case "CommonJsModule":
      return { name: module.name, commonJsModule: module.content };
    case "Text":
      return { name: module.name, text: module.content };
    case "Data":
      return { name: module.name, data: module.content };
    case "Wasm":
      return { name: module.name, wasm: module.content };
    case "Json":
      return { name: module.name, json: module.content };
    case "PythonModule":
      return { name: module.name, pythonModule: module.content };
    case "PythonRequirement":
      return { name: module.name, pythonRequirement: module.content };
  }
};
