import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as WorkflowsBindingWorker from "worker:./binding.worker.ts";
import * as WorkflowsWrappedBindingWorker from "worker:./wrapped-binding.worker.ts";
import * as Storage from "../../globals/Storage.ts";
import { SERVICE_USER_WORKER } from "../../internal/constants.ts";
import {
  formatExtensionModule,
  formatInternalWorkerModules,
} from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import * as PluginContext from "../../PluginContext.ts";
import { RegistryProxy } from "../../registry/RegistryProxy.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import type * as WorkerdConfig from "../../workerd/Config.ts";

const WORKFLOWS_WRAPPED_BINDING_MODULE = "cloudflare-runtime:workflows-wrapped-binding";
const WORKFLOWS_STORAGE_SERVICE_NAME = "workflows:storage";

export class Workflows extends Plugin.Service<
  Workflows,
  {
    readonly register: (
      workflow: WorkflowProps,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator, ConfigError>;
  }
>()("cloudflare-runtime/plugin/Workflows") {}

export const WorkflowsLive = Layer.effect(
  Workflows,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storage = yield* Storage.Storage;

    const makeStorageService = Effect.gen(function* () {
      const storageDiskPath = "disk" in storage ? storage.disk?.path : undefined;
      if (!storageDiskPath) {
        return yield* new ConfigError({
          subtag: "Workflows",
          message: "Cannot configure workflows persistence: the Storage service has no disk path.",
          hint: "Configure a disk-backed storage layer (`Storage.layerDisk` or `Storage.layerTemp`).",
        });
      }
      const persistPath = path.join(storageDiskPath, "workflows");
      yield* fs.makeDirectory(persistPath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ConfigError({
              subtag: "Workflows",
              message: `Failed to create workflows persistence directory "${persistPath}": ${cause.message}`,
              hint: "Ensure the storage directory is writable.",
              detail: { persistPath },
              cause,
            }),
        ),
      );
      return {
        name: WORKFLOWS_STORAGE_SERVICE_NAME,
        disk: { path: persistPath, writable: true },
      } satisfies WorkerdConfig.Service;
    });

    return Workflows.of(
      Effect.gen(function* () {
        const ctx = yield* PluginContext.PluginContext;
        const proxy = yield* ctx.get(RegistryProxy);
        const services: Array<WorkerdConfig.Service> = [];
        let hasWorkflows = false;

        // Cache the shared storage service creation so that there's only one per worker.
        // This prevents a race condition where two owned workflows would each observe
        // `services.length === 0` and push two separate `workflows:storage` services,
        // causing `workerd` to throw because of the duplicate service name.
        const ensureStorageService = yield* Effect.cached(
          makeStorageService.pipe(
            Effect.tap((service) => Effect.sync(() => services.push(service))),
          ),
        );

        return {
          defer: Effect.gen(function* () {
            const extension: WorkerdConfig.Extension = {
              modules: [
                {
                  name: WORKFLOWS_WRAPPED_BINDING_MODULE,
                  internal: true,
                  esModule: formatExtensionModule(WorkflowsWrappedBindingWorker),
                },
              ],
            };
            if (services.length === 0) {
              return { extensions: hasWorkflows ? [extension] : [] };
            }
            return {
              services,
              extensions: [extension],
            };
          }),
          api: {
            register: Effect.fnUntraced(function* (workflow) {
              hasWorkflows = true;
              if (workflow.scriptName && workflow.scriptName !== ctx.worker.name) {
                return yield* proxy.api.subscribe({
                  kind: "workflow",
                  scriptName: workflow.scriptName,
                  workflowName: workflow.workflowName,
                });
              }
              yield* ensureStorageService;
              const engineService = {
                name: `workflows:${workflow.workflowName}`,
                worker: {
                  compatibilityDate: "2024-10-22",
                  compatibilityFlags: ["experimental", ...(ctx.worker.compatibilityFlags ?? [])],
                  modules: formatInternalWorkerModules(WorkflowsBindingWorker),
                  durableObjectNamespaces: [
                    {
                      className: "Engine",
                      enableSql: true,
                      uniqueKey: encodeURIComponent(workflow.workflowName),
                      preventEviction: true,
                    },
                  ],
                  durableObjectStorage: {
                    localDisk: WORKFLOWS_STORAGE_SERVICE_NAME,
                  },
                  bindings: [
                    {
                      name: "ENGINE",
                      durableObjectNamespace: { className: "Engine" },
                    },
                    {
                      name: "USER_WORKFLOW",
                      service: {
                        name: SERVICE_USER_WORKER,
                        entrypoint: workflow.className,
                      },
                    },
                    {
                      name: "BINDING_NAME",
                      json: JSON.stringify(workflow.binding),
                    },
                    ...(workflow.stepLimit !== undefined
                      ? [
                          {
                            name: "STEP_LIMIT",
                            json: JSON.stringify(workflow.stepLimit),
                          },
                        ]
                      : []),
                  ],
                },
              } satisfies WorkerdConfig.Service;
              services.push(engineService);
              yield* proxy.api.publish({
                kind: "workflow",
                workflowName: workflow.workflowName,
                service: engineService.name,
              });
              return {
                name: engineService.name,
                entrypoint: "WorkflowBinding",
              };
            }),
          },
        };
      }),
    );
  }),
);

export interface WorkflowProps {
  readonly binding: string;
  readonly workflowName: string;
  readonly className: string;
  readonly scriptName?: string;
  readonly stepLimit?: number;
}

/**
 * Bind a workflow. The binding's engine lives in the worker whose
 * `WorkflowEntrypoint` class implements the workflow:
 *
 * - If the entry has no `scriptName` (or matches the current worker), this
 *   worker owns the engine and the wrapped binding routes to a local
 *   `workflows:<name>` service.
 * - Otherwise the binding routes through the dev-registry proxy to the
 *   owner instance, so engine state lives in exactly one process.
 */
export const local = (props: WorkflowProps): PluginContext.BindingHook<Workflows | RegistryProxy> =>
  Plugin.use(Workflows, (workflows) =>
    Effect.map(workflows.api.register(props), (service) => ({
      name: props.binding,
      wrapped: {
        moduleName: WORKFLOWS_WRAPPED_BINDING_MODULE,
        innerBindings: [{ name: "binding", service }],
      },
    })),
  );

export const remote = (props: WorkflowProps) =>
  makeRemoteBinding(
    {
      name: props.binding,
      type: "workflow",
      workflowName: props.workflowName,
      className: props.className,
      scriptName: props.scriptName,
    },
    (service) => ({
      name: props.binding,
      service,
    }),
  );
