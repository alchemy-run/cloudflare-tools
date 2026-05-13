import type { BindingHooks, Module, RuntimeConfig } from "@distilled.cloud/cloudflare-runtime";
import { layerRuntime, Runtime } from "@distilled.cloud/cloudflare-runtime";
import {
  DurableObjectNamespace,
  Json,
  Loopback,
  UnsafeEval,
} from "@distilled.cloud/cloudflare-runtime/bindings";
import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as vite from "vite";
import * as ModuleRunnerWorker from "worker:./module-runner/module-runner.worker.ts";
import * as WrapperWorker from "worker:./module-runner/wrapper.worker.ts";
import { ENVIRONMENT_NAME_HEADER } from "./module-runner/constants.shared.ts";
import type { CloudflareVitePluginOptions } from "./plugin";

export type ServerContext = Awaited<ReturnType<typeof createContext>>;
export type ServerHandle = Awaited<ReturnType<typeof startServer>>;

export const createContext = async (
  config: RuntimeConfig = {
    server: { port: 1337, host: "localhost" },
    api: { accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", credentials: Credentials.fromEnv() },
  },
) => {
  const scope = Scope.makeUnsafe();
  const context = await layerRuntime(config).pipe(
    Layer.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
    Layer.buildWithScope(scope),
    Effect.runPromise,
  );
  return {
    context,
    scope,
    close: () => closeScope(scope),
  };
};

export const startServer = async <B extends BindingHooks = BindingHooks>(
  options: CloudflareVitePluginOptions<B>,
  server: vite.ViteDevServer,
  context: ServerContext,
) => {
  const scope = Scope.forkUnsafe(context.scope);
  const address = await serve(options, server).pipe(
    Effect.provide(context.context),
    Scope.provide(scope),
    Effect.runPromise,
  );
  return {
    address,
    close: () => closeScope(scope),
  };
};

const closeScope = async (scope: Scope.Scope) => {
  await Effect.runPromiseExit(Scope.closeUnsafe(scope, Exit.void) ?? Effect.void);
};

const serve = Effect.fn(function* <B extends BindingHooks = BindingHooks>(
  options: CloudflareVitePluginOptions<B>,
  server: vite.ViteDevServer,
) {
  const runtime = yield* Runtime;
  return yield* runtime.start({
    name: "dev",
    modules: makeWorkerModules(options),
    compatibilityDate: options.compatibilityDate ?? "2026-05-12",
    compatibilityFlags: options.compatibilityFlags ?? [],
    bindings: [
      UnsafeEval.binding("__DISTILLED_UNSAFE_EVAL__"),
      DurableObjectNamespace.local("__DISTILLED_MODULE_RUNNER__", "ModuleRunnerDO"),
      Json.binding("__DISTILLED_ENVIRONMENT__", {
        environmentName: "ssr",
        entryId: vite.normalizePath(options.main ?? ""),
        entryName: options.main ?? "",
      }),
      Loopback.binding(
        "__DISTILLED_INVOKE_MODULE__",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const targetEnvironment = Headers.get(request.headers, ENVIRONMENT_NAME_HEADER).pipe(
            Option.getOrThrow,
          );
          const json = (yield* request.json) as unknown as vite.CustomPayload;
          const devEnvironment = server.environments[targetEnvironment];
          const result = yield* Effect.promise(
            async () => await devEnvironment.hot.handleInvoke(json),
          );
          return HttpServerResponse.jsonUnsafe(result);
        }),
      ),
      ...(options.bindings ?? []),
    ],
    durableObjectNamespaces: [
      {
        className: "ModuleRunnerDO",
        sql: false,
        ephemeralLocal: true,
      },
      ...(options.durableObjectNamespaces ?? []),
    ],
  });
});

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
