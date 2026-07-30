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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as NodeFs from "node:fs/promises";
import * as NodeHttp from "node:http";
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
  context: Context.Context<RuntimeServices.RuntimeServices>,
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

const makeModuleFallbackService = Effect.gen(function* () {
  const server = NodeHttp.createServer(async (req, res) => {
    try {
      const request = await parseModuleFallbackRequest(req);
      if (!request) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid module fallback request");
        return;
      }

      const candidate = request.rawSpecifier ?? request.specifier;
      const match = MODULE_REFERENCE_REGEX.exec(candidate);
      if (!match) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`No match for module: ${candidate}`);
        return;
      }

      const [, moduleType, modulePath] = match;
      if (!moduleType || !modulePath) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`Invalid module type or path: ${match[0]}`);
        return;
      }

      let content: Buffer;
      try {
        content = await NodeFs.readFile(modulePath);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end(`Module not found: ${modulePath}`);
        return;
      }

      switch (moduleType) {
        case "CompiledWasm": {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ wasm: Array.from(content) }));
          return;
        }
        case "Data": {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: Array.from(content) }));
          return;
        }
        case "Text": {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ text: content.toString() }));
          return;
        }
        default: {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`Invalid module type: ${moduleType}`);
        }
      }
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
  });

  yield* Effect.callback<void>((resume) => {
    server.listen(0, "127.0.0.1", () => resume(Effect.void));
  });
  yield* Effect.addFinalizer(() =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
  );

  const address = server.address();
  if (address === null || typeof address === "string") {
    return yield* Effect.die(new Error("Module fallback server address unavailable"));
  }
  return `127.0.0.1:${address.port}`;
});

const serve = Effect.fn(function* <B extends BindingHooks = BindingHooks>(
  options: CloudflareVitePluginOptions<B>,
  entryEnvironment: EntryEnvironment,
  server: vite.ViteDevServer,
) {
  const runtime = yield* Runtime.Runtime;
  const moduleFallback = yield* makeModuleFallbackService;

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
    workflows: options.worker?.workflows,
    hyperdrives: options.worker?.hyperdrives,
    assets: options.worker?.assets,
    unsafe: {
      moduleFallback,
      ...(options.worker?.unsafe ?? {}),
    },
  });
});

type ModuleFallbackRequest =
  | {
      protocol: "v1";
      type: "import" | "require";
      specifier: string;
      rawSpecifier?: string;
      referrer?: string;
    }
  | {
      protocol: "v2";
      type: "import" | "require" | "internal";
      specifier: string;
      rawSpecifier?: string;
      referrer?: string;
      attributes?: Array<{ name: string; value: string }>;
    };

const parseModuleFallbackRequest = async (
  req: NodeHttp.IncomingMessage,
): Promise<ModuleFallbackRequest | undefined> => {
  if (req.method === "GET" && req.headers["x-resolve-method"]) {
    const url = new URL(req.url ?? "", "http://localhost");
    const specifier = url.searchParams.get("specifier");
    if (!specifier) {
      return;
    }
    const resolveMethod = req.headers["x-resolve-method"];
    return {
      protocol: "v1",
      type: resolveMethod === "require" ? "require" : "import",
      specifier,
      rawSpecifier: url.searchParams.get("rawSpecifier") ?? undefined,
      referrer: url.searchParams.get("referrer") ?? undefined,
    };
  }

  if (req.method === "POST") {
    const chunks: Array<Buffer> = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const json: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (typeof json === "object" && json !== null && "specifier" in json) {
      return {
        protocol: "v2",
        ...(json as Omit<Extract<ModuleFallbackRequest, { protocol: "v2" }>, "protocol">),
      };
    }
  }
};

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
      // `@cloudflare/containers` outbound interception requires `ContainerProxy`
      // on `ctx.exports`. User `main` re-exports it, but workerd loads these
      // wrappers — not the user entry's export table — so expose it here too.
      'export const ContainerProxy = createWorkerEntrypointWrapper("ContainerProxy");',
      ...(options.worker?.durableObjectNamespaces ?? []).map(
        (namespace) =>
          `export const ${namespace.className} = createDurableObjectWrapper("${namespace.className}");`,
      ),
      ...(options.worker?.workflows ?? []).map(
        (workflow) =>
          `export const ${workflow.className} = createWorkflowEntrypointWrapper("${workflow.className}");`,
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
