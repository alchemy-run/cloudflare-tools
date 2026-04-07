import * as mf from "miniflare";
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface Module {
  path: string;
  type: "ESModule";
  contents: string | Uint8Array<ArrayBuffer>;
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
      modules.push({
        path: path.join(parent ?? "", file.name),
        type: "ESModule",
        contents: await fs.readFile(path.join(dir, file.name), "utf-8"),
      });
    }),
  );
  return modules;
}

const modules = await readModules("dist/server");
console.log(modules);

const miniflare = new mf.Miniflare({
  modules,
  compatibilityDate: "2026-03-10",
  compatibilityFlags: ["nodejs_compat"],
  assets: {
    directory: path.resolve(__dirname, "./dist/client"),
  },
});
await miniflare.ready;
