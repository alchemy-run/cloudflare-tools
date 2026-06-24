import { WORKER_ENTRY_PREFIX } from "@distilled.cloud/cloudflare-rolldown-plugin/plugins";
import type * as vite from "vite";
import type { CloudflareVitePluginOptions } from "./plugin";

export interface BuildResult {
  client?: { dir: string };
  server?: {
    entry: string;
    modules: Map<string, vite.Rolldown.OutputChunk | vite.Rolldown.OutputAsset>;
  };
}

export const builderPlugin = (options: CloudflareVitePluginOptions): vite.Plugin => {
  return {
    name: "distilled-cloudflare:build-result",
    buildApp: {
      order: "pre",
      handler: async (builder) => {
        let clientDir: string | undefined;
        let serverEntry: string | undefined;
        const serverModules = new Map<
          string,
          vite.Rolldown.OutputChunk | vite.Rolldown.OutputAsset
        >();
        for (const environment of Object.values(builder.environments)) {
          const result = await builder.build(environment);
          if (environment.name === "client") {
            clientDir = environment.config.build.outDir;
            continue;
          }
          if (!isRolldownOutput(result)) {
            throw new Error("Build result is not a RolldownOutput");
          }
          const chunk = result.output[0];
          if (chunk.facadeModuleId && chunk.facadeModuleId.startsWith(WORKER_ENTRY_PREFIX)) {
            serverEntry = chunk.fileName;
          }
          for (const chunk of result.output) {
            serverModules.set(chunk.fileName, chunk);
          }
        }
        options.onBuildComplete?.({
          client: clientDir ? { dir: clientDir } : undefined,
          server: serverEntry ? { entry: serverEntry, modules: serverModules } : undefined,
        });
      },
    },
  };
};

const isRolldownOutput = (
  result: Awaited<ReturnType<vite.ViteBuilder["build"]>>,
): result is vite.Rolldown.RolldownOutput => {
  return "output" in result && result.output.length > 0;
};
