import * as NodeHttp from "node:http";
import * as vite from "vite";
import { DistilledDevEnvironment } from "./dev-environment.js";
import { startServer, type ServerHandle } from "./dev-server.js";
import type { CloudflareVitePluginOptions } from "./plugin.js";

export function dev(options: CloudflareVitePluginOptions): vite.Plugin {
  let handle: ServerHandle | undefined;
  let isServerRestarting = false;
  const close = async () => {
    await handle?.close();
    handle = undefined;
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
      if (!options.context) {
        throw new Error("options.context is required for development");
      }
      handle ??= await startServer(options, server, options.context);
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
