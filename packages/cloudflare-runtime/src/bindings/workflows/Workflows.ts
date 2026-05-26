import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as WorkflowsBindingWorker from "worker:./binding.worker.ts";
import * as WorkflowsWrappedBindingWorker from "worker:./wrapped-binding.worker.ts";
import { USER_WORKER_SERVICE_NAME } from "../../dev-registry/Constants.shared.ts";
import * as Storage from "../../globals/Storage.ts";
import {
  formatExtensionModule,
  formatInternalWorkerModules,
} from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import * as PluginContext from "../../PluginContext.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import type * as WorkerdConfig from "../../workerd/Config.ts";
import type { WorkflowEntry } from "./WorkflowEntry.shared.ts";

const WORKFLOWS_WRAPPED_BINDING_MODULE = "cloudflare-runtime:workflows-wrapped-binding";
const WORKFLOWS_STORAGE_SERVICE_NAME = "workflows:storage";

export class Workflows extends Plugin.Service<Workflows, Record<string, WorkflowEntry>>()(
  "cloudflare-runtime/plugin/Workflows",
) {}

export const WorkflowsLive = Layer.effect(
  Workflows,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storage = yield* Storage.Storage;

    return Workflows.of(
      Effect.gen(function* () {
        const { worker } = yield* PluginContext.PluginContext;
        const workflows = worker.workflows ?? {};
        const entries = Object.entries(workflows);
        if (entries.length === 0) {
          return { api: {} };
        }
        const storageDiskPath = "disk" in storage ? storage.disk?.path : undefined;
        if (!storageDiskPath) {
          return yield* new ConfigError({
            subtag: "Workflows",
            message:
              "Cannot configure workflows persistence: the Storage service has no disk path.",
            hint: "Configure a disk-backed storage layer (`Storage.layerDisk` or `Storage.layerTemp`).",
            detail: { workflows: Object.keys(workflows) },
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

        const storageService: WorkerdConfig.Service = {
          name: WORKFLOWS_STORAGE_SERVICE_NAME,
          disk: { path: persistPath, writable: true },
        };

        const engineServices: Array<WorkerdConfig.Service> = entries.map(
          ([bindingName, workflow]): WorkerdConfig.Service => {
            const uniqueKey = `miniflare-workflows-${workflow.name}`;
            const bindings: Array<WorkerdConfig.Worker_Binding> = [
              {
                name: "ENGINE",
                durableObjectNamespace: { className: "Engine" },
              },
              {
                name: "USER_WORKFLOW",
                service: {
                  name: workflow.scriptName ?? USER_WORKER_SERVICE_NAME,
                  entrypoint: workflow.className,
                },
              },
              {
                name: "BINDING_NAME",
                json: JSON.stringify(bindingName),
              },
            ];
            if (workflow.stepLimit !== undefined) {
              bindings.push({
                name: "STEP_LIMIT",
                json: JSON.stringify(workflow.stepLimit),
              });
            }
            return {
              name: serviceNameForWorkflow(workflow.name),
              worker: {
                compatibilityDate: "2024-10-22",
                compatibilityFlags: ["experimental", ...(workflow.compatibilityFlags ?? [])],
                modules: formatInternalWorkerModules(WorkflowsBindingWorker),
                durableObjectNamespaces: [
                  {
                    className: "Engine",
                    enableSql: true,
                    uniqueKey,
                    preventEviction: true,
                  },
                ],
                durableObjectStorage: {
                  localDisk: WORKFLOWS_STORAGE_SERVICE_NAME,
                },
                bindings,
              },
            };
          },
        );

        return {
          services: [storageService, ...engineServices],
          extensions: [
            {
              modules: [
                {
                  name: WORKFLOWS_WRAPPED_BINDING_MODULE,
                  internal: true,
                  esModule: formatExtensionModule(WorkflowsWrappedBindingWorker),
                },
              ],
            },
          ],
          api: workflows,
        };
      }),
    );
  }),
);

const serviceNameForWorkflow = (workflowName: string) => `workflows:${workflowName}`;

export const local = (bindingName: string): PluginContext.BindingHook<Workflows> =>
  Plugin.use(Workflows, (workflows) => {
    const entry = workflows.api[bindingName];
    if (!entry) {
      return Effect.fail(
        new ConfigError({
          subtag: "Workflows",
          message: `No workflow entry was provided for binding "${bindingName}".`,
          hint: `Add an entry for "${bindingName}" to \`worker.workflows\`.`,
          detail: { bindingName },
        }),
      );
    }
    return Effect.succeed<WorkerdConfig.Worker_Binding>({
      name: bindingName,
      wrapped: {
        moduleName: WORKFLOWS_WRAPPED_BINDING_MODULE,
        innerBindings: [
          {
            name: "binding",
            service: {
              name: serviceNameForWorkflow(entry.name),
              entrypoint: "WorkflowBinding",
            },
          },
        ],
      },
    });
  });

export const remote = (bindingName: string, entry: WorkflowEntry) =>
  makeRemoteBinding(
    {
      name: bindingName,
      type: "workflow",
      workflowName: entry.name,
      className: entry.className,
      scriptName: entry.scriptName,
    },
    (service) => ({
      name: bindingName,
      service,
    }),
  );
