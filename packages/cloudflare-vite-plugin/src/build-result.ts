import { WORKER_ENTRY_PREFIX } from "@distilled.cloud/cloudflare-rolldown-plugin/plugins";
import type * as vite from "vite";
import type { CloudflareVitePluginOptions } from "./plugin";

export interface BuildResult {
  assetsDir?: string;
  server?: [
    vite.Rolldown.OutputChunk,
    ...Array<vite.Rolldown.OutputChunk | vite.Rolldown.OutputAsset>,
  ];
}

export const builderPlugin = (options: CloudflareVitePluginOptions): vite.Plugin => {
  return {
    name: "distilled-cloudflare:build-result",
    buildApp: {
      order: "pre",
      handler: async (builder) => {
        let assetsDir: string | undefined;
        let server: BuildResult["server"];
        const serverModules = new Map<
          string,
          vite.Rolldown.OutputChunk | vite.Rolldown.OutputAsset
        >();
        for (const environment of Object.values(builder.environments)) {
          const result = await builder.build(environment);
          if (environment.name === "client") {
            assetsDir = environment.config.build.outDir;
            continue;
          }
          if (!isRolldownOutput(result)) {
            throw new Error("Build result is not a RolldownOutput");
          }
          const chunk = result.output[0];
          if (chunk.facadeModuleId && chunk.facadeModuleId.startsWith(WORKER_ENTRY_PREFIX)) {
            if (server) {
              throw new Error("Multiple server entries found");
            }
            server = [chunk];
          } else {
            for (const chunk of result.output) {
              serverModules.set(chunk.fileName, chunk);
            }
          }
        }
        const keys = Array.from(serverModules.keys()).sort((a, b) => a.localeCompare(b));
        if (keys.length > 0) {
          if (!server) {
            throw new Error("Server entry not found");
          }
          for (const key of keys) {
            const chunk = serverModules.get(key);
            if (!chunk) {
              throw new Error(`Chunk ${key} not found`);
            }
            server.push(chunk);
          }
        }
        options.onBuildComplete?.({
          assetsDir,
          server,
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
