import type { BindingHooks, Module, RuntimeServices } from "@distilled.cloud/cloudflare-runtime";
import { layerRuntime, Runtime } from "@distilled.cloud/cloudflare-runtime";
import {
  DurableObjectNamespace,
  Json,
  Loopback,
  UnsafeEval,
} from "@distilled.cloud/cloudflare-runtime/bindings";
import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type * as vite from "vite";
import * as ModuleRunnerWorker from "worker:./module-runner/module-runner.worker.ts";
import * as WrapperWorker from "worker:./module-runner/wrapper.worker.ts";
import * as ViteAssets from "./assets/ViteAssets";
import { ENVIRONMENT_NAME_HEADER } from "./module-runner/constants.shared.ts";
import type { CloudflareVitePluginOptions } from "./plugin";

export type ServerHandle = Awaited<ReturnType<typeof startServer>>;

export const startServer = async <B extends BindingHooks = BindingHooks>(
  options: CloudflareVitePluginOptions<B>,
  entry: {
    id: string;
    name: string;
  },
  server: vite.ViteDevServer,
  context: Context.Context<RuntimeServices>,
) => {
  const scope = Scope.makeUnsafe();
  const address = await serve(options, entry, server).pipe(
    Effect.provide(ViteAssets.ViteAssetsLive(server)),
    Effect.provide(context),
    Scope.provide(scope),
    Effect.runPromise,
  );
  return {
    address,
    close: () => closeScope(scope),
  };
};

const importPlatformServices = Layer.unwrap(
  Effect.promise(async () => {
    try {
      const BunServices = await import("@effect/platform-bun/BunServices");
      return BunServices.layer;
    } catch {
      // ignore and fall back to NodeServices
    }
    const NodeServices = await import("@effect/platform-node/NodeServices");
    return NodeServices.layer;
  }),
);

export const createDefaultContext = async () => {
  const scope = Scope.makeUnsafe();

  return await layerRuntime({
    api: {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    },
  }).pipe(
    Layer.provide(
      Layer.mergeAll(Credentials.fromEnv(), importPlatformServices, FetchHttpClient.layer),
    ),
    Layer.buildWithScope(scope),
    Effect.runPromise,
  );
};

const closeScope = async (scope: Scope.Scope) => {
  await Effect.runPromiseExit(Scope.closeUnsafe(scope, Exit.void) ?? Effect.void);
};

const serve = Effect.fn(function* <B extends BindingHooks = BindingHooks>(
  options: CloudflareVitePluginOptions<B>,
  entry: {
    id: string;
    name: string;
  },
  server: vite.ViteDevServer,
) {
  const runtime = yield* Runtime;
  return yield* runtime.start({
    name: options.worker?.name ?? "vite-dev",
    modules: makeWorkerModules(options),
    compatibilityDate: options.compatibilityDate ?? "2026-05-12",
    compatibilityFlags: options.compatibilityFlags ?? [],
    bindings: [
      UnsafeEval.binding("__DISTILLED_UNSAFE_EVAL__"),
      DurableObjectNamespace.local({
        name: "__DISTILLED_MODULE_RUNNER__",
        className: "ModuleRunnerDO",
      }),
      Json.binding("__DISTILLED_ENVIRONMENT__", {
        environmentName: "ssr",
        entryId: entry.id,
        entryName: entry.name,
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
      ...(options.worker?.bindings ?? []),
    ],
    durableObjectNamespaces: [
      {
        className: "ModuleRunnerDO",
        sql: false,
        ephemeralLocal: true,
      },
      ...(options.worker?.durableObjectNamespaces ?? []),
    ],
    hyperdrives: options.worker?.hyperdrives,
    assets: options.worker?.assets,
  });
});

function makeWorkerModules(options: CloudflareVitePluginOptions): Array<Module> {
  const modules = {
    "index.worker.mjs": [
      `import { createWorkerEntrypointWrapper, createDurableObjectWrapper, createWorkflowEntrypointWrapper } from "./module-runner/wrapper.worker.mjs";`,
      'export { ModuleRunnerDO } from "./module-runner/module-runner.worker.mjs";',
      'export default createWorkerEntrypointWrapper("default");',
      ...(options.worker?.durableObjectNamespaces ?? []).map(
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
