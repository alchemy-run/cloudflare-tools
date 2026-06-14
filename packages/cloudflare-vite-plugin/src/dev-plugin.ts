import { workerEnvironments } from "@distilled.cloud/cloudflare-rolldown-plugin/options";
import type { OptionsApi } from "@distilled.cloud/cloudflare-rolldown-plugin/plugins";
import { resolvePluginApi } from "@distilled.cloud/cloudflare-rolldown-plugin/utils";
import type { RuntimeServices } from "@distilled.cloud/cloudflare-runtime";
import type * as Context from "effect/Context";
import * as NodeHttp from "node:http";
import * as vite from "vite";
import { DistilledDevEnvironment } from "./dev-environment.js";
import { createDefaultContext, startServer, type ServerHandle } from "./dev-server.js";
import type { CloudflareVitePluginOptions } from "./plugin.js";
import { handleWebSocket } from "./websockets.js";

let context: Context.Context<RuntimeServices> | undefined;

export function dev(options: CloudflareVitePluginOptions): vite.Plugin {
  let handle: ServerHandle | undefined;
  let isServerRestarting = false;
  let removeUpgradeListener: (() => void) | undefined;
  const close = async () => {
    removeUpgradeListener?.();
    removeUpgradeListener = undefined;
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
      const devEnvironmentConfig = {
        dev: {
          createEnvironment(name: string, config: vite.ResolvedConfig) {
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
      };
      // The entry environment and every child environment it loads at runtime
      // run in workerd with a module runner. (Default: the single `ssr` env.)
      return {
        environments: Object.fromEntries(
          workerEnvironments(options).all.map((name) => [name, devEnvironmentConfig]),
        ),
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
      const inputs = Object.values(optionsApi.input());
      if (inputs.length > 1) {
        throw new Error(
          `Expected exactly one entry in the input, got ${inputs.length} entries: ${JSON.stringify(inputs)}`,
        );
      }
      if (!options.context) {
        context ??= await createDefaultContext();
      }
      const [input] = inputs;
      handle ??= await startServer(
        options,
        { id: input, name: input },
        server,
        options.context ?? context!,
      );
      const address = handle.address;
      // Connect a module runner for the entry environment and each child it
      // loads at runtime, so cross-environment imports (e.g. an RSC entry
      // loading `ssr` modules) resolve to a live runner inside workerd.
      // Settle each environment's dep optimizer BEFORE its runner starts
      // importing: a re-optimization after first import re-hashes shared deps
      // and duplicates singletons like React (a null hooks dispatcher).
      for (const environmentName of workerEnvironments(options).all) {
        const environment = server.environments[environmentName];
        if (environment instanceof DistilledDevEnvironment) {
          await environment.depsOptimizer?.init();
          await environment.connect(address);
        }
      }
      if (!input) {
        // If there is no input, we are in SPA mode, so we don't need to route requests to the server.
        return;
      }
      if (server.httpServer) {
        removeUpgradeListener = handleWebSocket(server.httpServer, address);
      }
      return () => {
        server.middlewares.use((req, res) => {
          const url = new URL(req.url ?? "/", address);
          const request = NodeHttp.request(url, {
            method: req.method,
            headers: { ...req.headers, host: url.hostname },
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
