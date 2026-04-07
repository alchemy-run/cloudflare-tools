import * as mf from "miniflare";
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface Module {
  path: string;
  type:
    | "ESModule"
    | "CommonJS"
    | "Text"
    | "Data"
    | "CompiledWasm"
    | "PythonModule"
    | "PythonRequirement";
  contents?: string | Uint8Array<ArrayBuffer> | undefined;
}

async function readModules(dir: string, parent?: string): Promise<Array<Module>> {
  const files = await fs.readdir(dir, { withFileTypes: true });
  const modules: Array<Module> = [];
  await Promise.all(
    files.map(async (file) => {
      if (file.isDirectory()) {
        modules.push(
          ...(await readModules(path.join(dir, file.name), path.join(parent ?? "", file.name))),
        );
        return;
      }
      if (!file.isFile()) {
        console.warn(`Skipping non-file: ${path.join(dir, file.name)}`);
        return;
      }
      const type = file.name.endsWith(".js") ? "ESModule" : "Text";
      modules.push({
        path: path.join(parent ?? "", file.name),
        type,
        contents: await fs.readFile(path.join(dir, file.name), "utf-8"),
      });
    }),
  );
  return modules;
}

const modules = await readModules("dist/server");
console.log(modules.map((m) => ({ path: m.path, type: m.type, contents: m.contents?.length })));

const miniflare = new mf.Miniflare({
  port: 3000,
  modules,
  compatibilityDate: "2026-03-10",
  compatibilityFlags: ["nodejs_compat"],
  assets: {
    directory: path.resolve(__dirname, "./dist/client"),
    routerConfig: {
      has_user_worker: true,
      invoke_user_worker_ahead_of_assets: false,
      debug: true,
    },
    assetConfig: {
      html_handling: "auto-trailing-slash",
      not_found_handling: "none",
      debug: true,
      has_static_routing: false,
    },
  },
});
const ready = await miniflare.ready;
console.log(ready.toString());

// const res = await miniflare.dispatchFetch(ready);
// assert.equal(res.status, 200);
// await miniflare.dispose();
