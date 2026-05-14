import type { OptionsApi } from "@distilled.cloud/cloudflare-rolldown-plugin/plugins";
import { resolvePluginApi } from "@distilled.cloud/cloudflare-rolldown-plugin/utils";
import type { RuntimeServices } from "@distilled.cloud/cloudflare-runtime";
import type * as Context from "effect/Context";
import * as NodeHttp from "node:http";
import * as vite from "vite";
import { DistilledDevEnvironment } from "./dev-environment.js";
import { createDefaultContext, startServer, type ServerHandle } from "./dev-server.js";
import type { CloudflareVitePluginOptions } from "./plugin.js";

let context: Context.Context<RuntimeServices> | undefined;

export function dev(options: CloudflareVitePluginOptions): vite.Plugin {
  let handle: ServerHandle | undefined;
  let isServerRestarting = false;
  const close = async () => {
    await handle?.close();
    handle = undefined;
  };
  let optionsApi: OptionsApi | undefined;
  return {
    name: "distilled-cloudflare:dev",
    configResolved({ plugins }) {
      optionsApi = resolvePluginApi<OptionsApi>(plugins ?? [], "distilled-cloudflare:options");
    },
    config() {
      return {
        environments: {
          ssr: {
            dev: {
              createEnvironment(name, config) {
                const hasConfigureServer = config.plugins.some(
                  (plugin) =>
                    plugin.name === "distilled-cloudflare:dev" &&
                    plugin.configureServer !== undefined,
                );
                if (!hasConfigureServer) {
                  return vite.createRunnableDevEnvironment(name, config);
                }

                return new DistilledDevEnvironment(name, config);
              },
            },
          },
        },
      };
    },
    async buildEnd() {
      if (!isServerRestarting) {
        await close();
      }
    },
    async closeBundle() {
      if (!isServerRestarting) {
        await close();
      }
    },
    async configureServer(server) {
      const restartServer = server.restart.bind(server);
      server.restart = async () => {
        try {
          isServerRestarting = true;
          await restartServer();
        } finally {
          isServerRestarting = false;
        }
      };
      if (!optionsApi) {
        throw new Error("Cannot resolve the cloudflare-runtime:options plugin");
      }
      const input = Object.entries(optionsApi.input());
      if (input.length > 1) {
        throw new Error(
          `Expected exactly one entry in the input, got ${input.length} entries: ${JSON.stringify(input)}`,
        );
      }
      const [name, id] = input[0] ?? [];
      if (!options.context) {
        context ??= await createDefaultContext();
      }
      handle ??= await startServer(options, { id, name }, server, options.context ?? context!);
      const address = handle.address;
      const ssrEnvironment = server.environments.ssr;
      if (ssrEnvironment instanceof DistilledDevEnvironment) {
        await ssrEnvironment.connect(address);
      }
      return () => {
        server.middlewares.use((req, res) => {
          const url = new URL(req.url ?? "/", `http://${address}`);
          const request = NodeHttp.request(url, {
            method: req.method,
            headers: { ...req.headers, host: address.split(":")[0] },
          });
          req.pipe(request);
          request.on("response", (response) => {
            res.writeHead(response.statusCode ?? 500, response.headers);
            response.pipe(res);
          });
        });
      };
    },
  };
}
