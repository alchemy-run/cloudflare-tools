import * as NodeHttp from "node:http";
import * as vite from "vite";
import { DistilledDevEnvironment } from "./dev-environment";
import { createContext, startServer, type ServerContext, type ServerHandle } from "./dev-server";
import type { CloudflareVitePluginOptions } from "./plugin";

let context: ServerContext | undefined;
let handle: ServerHandle | undefined;
let isServerRestarting = false;

export function dev(options: CloudflareVitePluginOptions): vite.Plugin {
  const close = async () => {
    await handle?.close();
    handle = undefined;
    await context?.close();
    context = undefined;
  };
  return {
    name: "distilled-cloudflare:dev",
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
      context = await createContext(options.server);
      handle ??= await startServer(options, server, context);
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
