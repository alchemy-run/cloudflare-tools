import { parseViteEnvironments } from "@distilled.cloud/cloudflare-rolldown-plugin/options";
import type { OptionsApi } from "@distilled.cloud/cloudflare-rolldown-plugin/plugins";
import { resolvePluginApi } from "@distilled.cloud/cloudflare-rolldown-plugin/utils";
import type { RuntimeServices } from "@distilled.cloud/cloudflare-runtime";
import type * as Context from "effect/Context";
import * as NodeHttp from "node:http";
import * as vite from "vite";
import { DistilledDevEnvironment } from "./dev-environment.js";
import type { ServerHandle } from "./dev-server.js";
import { resolveForwardedHost } from "./forwarded-host.js";
import type { CloudflareVitePluginOptions } from "./plugin.js";
import { handleWebSocket } from "./websockets.js";

let context: Context.Context<RuntimeServices> | undefined;

export function dev(options: CloudflareVitePluginOptions): Array<vite.Plugin> {
  const environmentNames = parseViteEnvironments(options);
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
  const plugins: Array<vite.Plugin> = [];
  // The proxy middleware registers in a `configureServer` post callback, which
  // Vite runs in plugin order — so when this plugin is appended after a
  // framework's plugins, the framework's own post middlewares (e.g. a Node
  // request bridge that assumes a runnable environment) would see requests
  // first. With `middlewareOrder: "pre"` the proxy is instead inserted
  // directly after Vite's internal middlewares, ahead of every other plugin's
  // post middlewares. This companion plugin records that insertion point: its
  // post callback runs before all normal plugins' post callbacks (it is
  // `enforce: "pre"`), i.e. right after Vite registered its internal
  // middlewares and before any other plugin registered post middlewares.
  let middlewareBoundary: number | undefined;
  if (options.dev?.middlewareOrder === "pre") {
    plugins.push({
      name: "distilled-cloudflare:dev-middleware-boundary",
      enforce: "pre",
      configureServer(server) {
        middlewareBoundary = undefined;
        return () => {
          middlewareBoundary = server.middlewares.stack.length;
        };
      },
    });
  }
  const plugin: vite.Plugin = {
    name: "distilled-cloudflare:dev",
    configResolved({ plugins }) {
      optionsApi = resolvePluginApi<OptionsApi>(plugins ?? [], "distilled-cloudflare:options");
    },
    config() {
      const environment: vite.EnvironmentOptions = {
        dev: {
          createEnvironment(name, config) {
            // Framework integrations strip `configureServer` off this plugin
            // when they create throwaway dev servers (e.g. Astro's type-gen
            // during `build`/`sync`) so we don't boot workerd mid-build. In
            // that case there is no runtime to proxy to — degrade to Vite's
            // default runnable environment. Check this exact plugin instance
            // (not the resolved plugin list) so multiple instances and
            // renamed/wrapped plugins behave predictably.
            if (!hasConfigureServerHook(plugin)) {
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
      handle ??= await startServer(
        options,
        { environmentName: environmentNames[0], entryId: input, entryName: input },
        server,
        options.context ?? context!,
      );
      const address = handle.address;
      for (const environmentName of environmentNames) {
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
        server.middlewares.use(function distilledCloudflareProxyMiddleware(req, res) {
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
        if (options.dev?.middlewareOrder === "pre" && middlewareBoundary !== undefined) {
          // Move the proxy middleware from the end of the stack to directly
          // after Vite's internal middlewares, ahead of the post middlewares
          // other plugins registered.
          const stack = server.middlewares.stack;
          const entry = stack.pop();
          if (entry) {
            stack.splice(middlewareBoundary, 0, entry);
          }
        }
      };
    },
  };
  plugins.push(plugin);
  return plugins;
}

const hasConfigureServerHook = (plugin: vite.Plugin): boolean => {
  const hook = plugin.configureServer;
  if (hook == null) return false;
  return typeof hook === "function" || typeof hook.handler === "function";
};
