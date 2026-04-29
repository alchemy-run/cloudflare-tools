import type * as Worker from "../Worker.ts";
import type { Worker_Module } from "../workerd/Config.ts";

export function convertWorkerModules(modules: Array<Worker.Module>): Array<Worker_Module> {
  return modules.map(convertWorkerModule);
}

function convertWorkerModule(module: Worker.Module): Worker_Module {
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
}
