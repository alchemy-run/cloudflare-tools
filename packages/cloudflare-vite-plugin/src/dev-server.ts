import { MODULE_REFERENCE_REGEX } from "@distilled.cloud/cloudflare-rolldown-plugin/plugins";
import type { BindingHooks, Module } from "@distilled.cloud/cloudflare-runtime";
import * as Runtime from "@distilled.cloud/cloudflare-runtime/Runtime";
import * as RuntimeServices from "@distilled.cloud/cloudflare-runtime/RuntimeServices";
import * as DurableObjectNamespace from "@distilled.cloud/cloudflare-runtime/bindings/DurableObjectNamespace";
import * as Json from "@distilled.cloud/cloudflare-runtime/bindings/Json";
import * as Loopback from "@distilled.cloud/cloudflare-runtime/bindings/Loopback";
import * as UnsafeEval from "@distilled.cloud/cloudflare-runtime/bindings/UnsafeEval";
import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
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
import type { EntryEnvironment } from "./module-runner/constants.shared.ts";
import { ENVIRONMENT_NAME_HEADER } from "./module-runner/constants.shared.ts";
import type { CloudflareVitePluginOptions } from "./plugin";

export type ServerHandle = Awaited<ReturnType<typeof startServer>>;

export const startServer = async <B extends BindingHooks = BindingHooks>(
  options: CloudflareVitePluginOptions<B>,
  entryEnvironment: EntryEnvironment,
  server: vite.ViteDevServer,
  context: Context.Context<RuntimeServices.RuntimeServices | FileSystem.FileSystem>,
) => {
  const scope = Scope.makeUnsafe();
  const address = await serve(options, entryEnvironment, server).pipe(
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

export const createDefaultContext = async (): Promise<
  Context.Context<RuntimeServices.RuntimeServices>
> => {
  const scope = Scope.makeUnsafe();

  return await RuntimeServices.layerRuntime({
    api: {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    },
  }).pipe(
    Layer.provideMerge(importPlatformServices),
    Layer.provide(Layer.merge(Credentials.fromEnv(), FetchHttpClient.layer)),
    Layer.buildWithScope(scope),
    Effect.runPromise,
  );
};

const closeScope = async (scope: Scope.Scope) => {
  await Effect.runPromiseExit(Scope.closeUnsafe(scope, Exit.void) ?? Effect.void);
};

const serve = Effect.fn(function* <B extends BindingHooks = BindingHooks>(
  options: CloudflareVitePluginOptions<B>,
  entryEnvironment: EntryEnvironment,
  server: vite.ViteDevServer,
) {
  const runtime = yield* Runtime.Runtime;
  const fs = yield* FileSystem.FileSystem;

  const name = options.worker?.name ?? `vite-dev-${crypto.randomUUID()}`;
  return yield* runtime.start({
    name,
    modules: yield* Effect.promise(() => makeWorkerModules(options)),
    compatibilityDate: options.compatibilityDate ?? "2026-05-12",
    compatibilityFlags: options.compatibilityFlags ?? [],
    bindings: [
      UnsafeEval.local("__DISTILLED_UNSAFE_EVAL__"),
      DurableObjectNamespace.local({
        binding: "__DISTILLED_MODULE_RUNNER__",
        className: "ModuleRunnerDO",
      }),
      Json.local("__DISTILLED_ENVIRONMENT__", entryEnvironment),
      Loopback.local({
        binding: "__DISTILLED_INVOKE_MODULE__",
        name: `vite:invoke-module:${name}`,
        handler: Effect.gen(function* () {
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
      }),
      Loopback.local({
        binding: "__DISTILLED_MODULE_FALLBACK__",
        name: `vite:module-fallback:${name}`,
        handler: Effect.gen(function* () {
          const request = yield* ModuleFallbackRequest.pipe(Effect.orElseSucceed(() => undefined));
          if (!request) {
            return HttpServerResponse.text("Invalid module fallback request", { status: 400 });
          }
          const match = MODULE_REFERENCE_REGEX.exec(request.specifier);
          if (!match) {
            return HttpServerResponse.text(`No match for module: ${request.specifier}`, {
              status: 400,
            });
          }
          const [full, moduleType, modulePath] = match;
          if (!moduleType || !modulePath) {
            return HttpServerResponse.text(`Invalid module type or path: ${full}`, { status: 400 });
          }
          const content = yield* fs
            .readFile(modulePath)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
          if (!content) {
            return HttpServerResponse.text(`Module not found: ${modulePath}`, { status: 404 });
          }
          switch (moduleType) {
            case "CompiledWasm": {
              return yield* HttpServerResponse.json({ wasm: Array.from(content) });
            }
            case "Data": {
              return yield* HttpServerResponse.json({ data: Array.from(content) });
            }
            case "Text": {
              return yield* HttpServerResponse.json({ text: content.toString() });
            }
            default: {
              return HttpServerResponse.text(`Invalid module type: ${moduleType}`, { status: 400 });
            }
          }
        }),
      }),
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
    unsafe: {
      moduleFallback: `vite:module-fallback:${name}`,
      ...(options.worker?.unsafe ?? {}),
    },
  });
});

const ModuleFallbackRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.method === "GET") {
    const url = new URL(request.url, "http://localhost");
    const specifier = url.searchParams.get("specifier");

    if (!specifier) {
      return;
    }

    const resolveMethod = Headers.get(request.headers, "X-Resolve-Method").pipe(Option.getOrThrow);

    return {
      protocol: "v1",
      type: resolveMethod === "require" ? "require" : "import",
      specifier,
      rawSpecifier: url.searchParams.get("rawSpecifier") ?? undefined,
      referrer: url.searchParams.get("referrer") ?? undefined,
    } as ModuleFallbackRequest.V1;
  } else if (request.method === "POST") {
    const json = yield* request.json;
    if (!isV2ModuleFallbackProtocol(json)) {
      return;
    }
    return { protocol: "v2", ...json } as ModuleFallbackRequest.V2;
  }
});

const isV2ModuleFallbackProtocol = (
  json: unknown,
): json is Omit<ModuleFallbackRequest.V2, "protocol"> => {
  return typeof json === "object" && json !== null && "specifier" in json;
};

declare namespace ModuleFallbackRequest {
  /** V1 protocol request (legacy module registry) */
  export interface V1 {
    protocol: "v1";
    /** Import type: "import" for ES modules, "require" for CommonJS */
    type: "import" | "require";
    /** Module specifier as a path (e.g., "/my-module.js") */
    specifier: string;
    /** Original specifier as written in source code */
    rawSpecifier?: string;
    /** Referrer module path */
    referrer?: string;
  }

  /** V2 protocol request (new module registry) */
  export interface V2 {
    protocol: "v2";
    /** Import type: includes "internal" for runtime-originated imports */
    type: "import" | "require" | "internal";
    /** Module specifier as a URL (e.g., "file:///bundle/my-module.js") */
    specifier: string;
    /** Original specifier as written in source code */
    rawSpecifier?: string;
    /** Referrer module URL */
    referrer?: string;
    /** Import attributes from the import statement */
    attributes?: Array<{ name: string; value: string }>;
  }
}

async function makeWorkerModules(options: CloudflareVitePluginOptions): Promise<Array<Module>> {
  const [moduleRunnerWorker, wrapperWorker] = await Promise.all([
    ModuleRunnerWorker.worker(),
    WrapperWorker.worker(),
  ]);
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
    ...moduleRunnerWorker.modules,
    ...wrapperWorker.modules,
  };
  return Object.entries(modules).map(([name, content]) => ({
    name,
    type: "ESModule",
    content,
  }));
}
