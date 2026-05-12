// oxlint-disable no-console
import { Runtime, layerRuntime, type Module } from "@distilled.cloud/cloudflare-runtime";
import {
  DurableObjectNamespace,
  Json,
  Loopback,
  UnsafeEval,
} from "@distilled.cloud/cloudflare-runtime/bindings";
import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Option } from "effect";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as NodeHttp from "node:http";
import * as vite from "vite";
import * as ModuleRunnerWorker from "worker:./module-runner/module-runner.worker.ts";
import * as WrapperWorker from "worker:./module-runner/wrapper.worker.ts";
import { DistilledDevEnvironment } from "./dev-environment";
import { ENVIRONMENT_NAME_HEADER } from "./module-runner/constants.shared";
import type { CloudflareVitePluginOptions } from "./plugin";

const scope = Scope.makeUnsafe();

let running = false;

const handleExit = async () => {
  if (running) return;
  running = true;
  // eslint-disable-next-line no-console
  console.log("Shutting down");
  await Effect.runPromise(Scope.closeUnsafe(scope, Exit.void) ?? Effect.void);
  process.off("SIGINT", handleExit);
  process.off("SIGTERM", handleExit);
  // eslint-disable-next-line no-console
  console.log("Shutdown complete");
  process.exit(0);
};

process.on("SIGINT", handleExit);
process.on("SIGTERM", handleExit);

export function dev(options: CloudflareVitePluginOptions): vite.Plugin {
  return {
    name: "distilled-cloudflare:dev",
    config(config) {
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
                  console.log(`No configureServer hook, using runnable environment for ${name}`);
                  return vite.createRunnableDevEnvironment(name, config);
                }
                console.log(`Using dev environment for ${name}`);
                return new DistilledDevEnvironment(name, config);
              },
            },
          },
        },
      };
    },
    async configureServer(server) {
      const fork = Scope.forkUnsafe(scope);
      const address = await Layer.buildWithScope(
        layerRuntime({
          api: {
            accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
            credentials: Credentials.fromEnv(),
          },
          server: { port: 1337, host: "localhost" },
        }),
        fork,
      ).pipe(
        Effect.flatMap((context) =>
          Runtime.use((runtime) =>
            runtime.start({
              name: "dev",
              compatibilityDate: "2026-05-12",
              compatibilityFlags: [],
              bindings: [
                UnsafeEval.binding("__DISTILLED_UNSAFE_EVAL__"),
                DurableObjectNamespace.local("__DISTILLED_MODULE_RUNNER__", "ModuleRunnerDO"),
                Json.binding("__DISTILLED_ENVIRONMENT__", {
                  environmentName: "ssr",
                  entryId: options.main ?? "",
                  entryName: options.main ?? "",
                }),
                Loopback.binding(
                  "__DISTILLED_INVOKE_MODULE__",
                  Effect.gen(function* () {
                    const request = yield* HttpServerRequest.HttpServerRequest;
                    const targetEnvironment = Headers.get(
                      request.headers,
                      ENVIRONMENT_NAME_HEADER,
                    ).pipe(Option.getOrThrow);
                    const json = (yield* request.json) as unknown as vite.CustomPayload;
                    const devEnvironment = server.environments[targetEnvironment];
                    const result = yield* Effect.promise(
                      async () => await devEnvironment.hot.handleInvoke(json),
                    );
                    return HttpServerResponse.jsonUnsafe(result);
                  }),
                ),
              ],
              modules: makeWorkerModules(options),
              durableObjectNamespaces: [
                {
                  className: "ModuleRunnerDO",
                  sql: false,
                  ephemeralLocal: true,
                },
              ],
            }),
          ).pipe(Effect.provide(context)),
        ),
        Effect.provide(NodeServices.layer),
        Effect.provide(FetchHttpClient.layer),
        Scope.provide(fork),
        Effect.runPromise,
      );
      console.log(`Server running at ${address}`);
      console.log("Server environments:", Object.keys(server.environments));
      console.dir(server.environments, { depth: 1 });
      const environment = server.environments.ssr as DistilledDevEnvironment;
      await environment.connect(address);
      const close = async () => {
        console.log("Server closed, shutting down");
        await Effect.runPromise(Scope.closeUnsafe(fork, Exit.void) ?? Effect.void);
        console.log("Server closed, shutdown complete");
        server.httpServer?.off("close", close);
      };
      server.httpServer?.on("close", close);
      return () => {
        console.log("Running le hook");
        server.middlewares.use((req, res, next) => {
          console.log("Middleware running");
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
          request.on("error", (error) => {
            console.error("Error proxying request:", error);
            res.statusCode = 500;
            res.end("Internal Server Error");
          });
        });
      };
    },
  };
}

function makeWorkerModules(options: CloudflareVitePluginOptions): Array<Module> {
  const modules = {
    "index.worker.mjs": [
      `import { createWorkerEntrypointWrapper, createDurableObjectWrapper, createWorkflowEntrypointWrapper } from "./module-runner/wrapper.worker.mjs";`,
      'export { ModuleRunnerDO } from "./module-runner/module-runner.worker.mjs";',
      'export default createWorkerEntrypointWrapper("default");',
      ...(options.durableObjectNamespaces ?? []).map(
        (namespace) =>
          `export const ${namespace.className} = createDurableObjectWrapper("${namespace.className}");`,
      ),
    ].join("\n"),
    ...ModuleRunnerWorker.modules,
    ...WrapperWorker.modules,
  };
  return Object.entries(modules).map(([name, content]) => ({
    name,
    type: "ESModule",
    content,
  }));
}
