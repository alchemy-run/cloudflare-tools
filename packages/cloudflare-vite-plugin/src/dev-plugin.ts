import type { ExportTypes } from "@distilled.cloud/cloudflare-rolldown-plugin/export-types";
import {
  haveExportTypesChanged,
  isExportTypes,
  WORKER_EXPORT_TYPES_EVENT,
} from "@distilled.cloud/cloudflare-rolldown-plugin/export-types";
import { parseViteEnvironments } from "@distilled.cloud/cloudflare-rolldown-plugin/options";
import type { OptionsApi } from "@distilled.cloud/cloudflare-rolldown-plugin/plugins";
import { workerEntryId } from "@distilled.cloud/cloudflare-rolldown-plugin/plugins";
import { resolvePluginApi } from "@distilled.cloud/cloudflare-rolldown-plugin/utils";
import type { RuntimeServices } from "@distilled.cloud/cloudflare-runtime";
import type * as Context from "effect/Context";
import * as NodeHttp from "node:http";
import * as vite from "vite";
import { DistilledDevEnvironment } from "./dev-environment.js";
import type { ServerHandle } from "./dev-server.js";
import { configuredExportTypes, mergeExportTypes } from "./export-types.js";
import { resolveForwardedHost } from "./forwarded-host.js";
import type { CloudflareVitePluginOptions } from "./plugin.js";
import { handleWebSocket } from "./websockets.js";

let context: Context.Context<RuntimeServices> | undefined;

export function dev(options: CloudflareVitePluginOptions): vite.Plugin {
  const environmentNames = parseViteEnvironments(options);
  const configured = configuredExportTypes(options);
  // Which exports the running Worker was generated for. Kept across dev server
  // restarts so a restart does not undo what was detected.
  let exportTypes: ExportTypes = configured;
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
      const environment: vite.EnvironmentOptions = {
        dev: {
          createEnvironment(name, config) {
            const hasConfigureServer = config.plugins.some(
              (plugin) =>
                plugin.name === "distilled-cloudflare:dev" && plugin.configureServer !== undefined,
            );
            if (!hasConfigureServer) {
              return vite.createRunnableDevEnvironment(name, config);
            }
            return new DistilledDevEnvironment(name, config);
          },
        },
      };
      return {
        environments: Object.fromEntries(environmentNames.map((name) => [name, environment])),
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
      const { createDefaultContext, startServer } = await import("./dev-server.ts");
      if (!options.context) {
        context ??= await createDefaultContext();
      }
      const [input] = inputs;
      const entryEnvironment = {
        environmentName: environmentNames[0],
        // The module runner imports the generated Worker entry rather than the
        // user entry: it is the module that re-exports everything the Worker
        // needs and that reports its export types over `import.meta.hot`.
        entryId: input ? workerEntryId(input) : input,
        entryName: input,
      };
      const entryEnvironments = () =>
        environmentNames
          .map((name) => server.environments[name])
          .filter((environment) => environment instanceof DistilledDevEnvironment);

      const connect = async (address: string | URL) => {
        for (const environment of entryEnvironments()) {
          await environment.depsOptimizer?.init();
          await environment.connect(address);
        }
      };
      handle ??= await startServer(
        options,
        entryEnvironment,
        server,
        options.context ?? context!,
        exportTypes,
      );
      await connect(handle.address);
      let address = handle.address;

      const bindWebSocket = () => {
        removeUpgradeListener?.();
        removeUpgradeListener = server.httpServer
          ? handleWebSocket(server.httpServer, address)
          : undefined;
      };

      /**
       * Replaces the Worker runtime so it is regenerated for `exportTypes`.
       * workerd needs a named export for every entrypoint, Durable Object, and
       * Workflow class, and those exports are baked into the Worker's entry
       * module at startup.
       */
      const restartRuntime = async () => {
        await handle?.close();
        handle = await startServer(
          options,
          entryEnvironment,
          server,
          options.context ?? context!,
          exportTypes,
        );
        await connect(handle.address);
        address = handle.address;
        bindWebSocket();
      };

      /**
       * Applies export types reported by the Worker. Returns `true` when they
       * no longer match what the running Worker was generated for, in which
       * case a runtime restart has been queued on `applying`.
       */
      let applying: Promise<void> = Promise.resolve();
      const applyExportTypes = (detected: ExportTypes): boolean => {
        const next = mergeExportTypes(configured, detected);
        if (!haveExportTypesChanged(exportTypes, next)) {
          return false;
        }
        exportTypes = next;
        applying = applying
          .catch(() => {})
          .then(restartRuntime)
          .catch((error: unknown) => {
            server.config.logger.error(`Failed to reload the Worker runtime: ${String(error)}`, {
              error: error instanceof Error ? error : undefined,
              timestamp: true,
            });
          });
        return true;
      };

      if (input) {
        // Detect up front so that the first request already reaches a Worker
        // exposing every entrypoint the entry module defines.
        const detected = await entryEnvironments()[0]?.requestExportTypes();
        if (detected && applyExportTypes(detected)) {
          await applying;
        }
        // From here on the entry reports its exports over HMR every time it is
        // re-evaluated, which is how entrypoints added later get picked up.
        for (const environment of entryEnvironments()) {
          environment.hot.on(WORKER_EXPORT_TYPES_EVENT, (data: unknown) => {
            if (!isExportTypes(data) || !applyExportTypes(data)) {
              return;
            }
            server.config.logger.info("Worker exports changed, reloading the Worker runtime.", {
              timestamp: true,
            });
          });
        }
      }

      if (!input) {
        // If there is no input, we are in SPA mode, so we don't need to route requests to the server.
        return;
      }
      bindWebSocket();
      return () => {
        server.middlewares.use((req, res) => {
          const url = new URL(req.originalUrl ?? req.url ?? "/", address);
          const request = NodeHttp.request(url, {
            method: req.method,
            headers: { ...req.headers, host: resolveForwardedHost(req.headers, url.host) },
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
