import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as WorkflowsBindingWorker from "worker:./binding.worker.ts";
import * as WorkflowsWrappedBindingWorker from "worker:./wrapped-binding.worker.ts";
import { USER_WORKER_SERVICE_NAME } from "../../dev-registry/Constants.shared.ts";
import { DevRegistryProxy } from "../../dev-registry/DevRegistryProxy.ts";
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

interface WorkflowsApi {
  /** Resolved entries from `worker.workflows`, keyed by binding name. */
  readonly entries: Record<string, WorkflowEntry>;
  /**
   * Subset of {@link entries} where the workflow is owned by the current
   * worker — either no `scriptName` was set, or it matches the current
   * worker. These are the bindings that route through the local Engine.
   */
  readonly ownedBindings: ReadonlySet<string>;
}

export class Workflows extends Plugin.Service<Workflows, WorkflowsApi>()(
  "cloudflare-runtime/plugin/Workflows",
) {}

/**
 * Decide whether the current worker owns the engine for a given workflow.
 *
 * A workflow's engine state must live in exactly one process; otherwise
 * different consumers would observe diverging state. The owner is the
 * worker that *defines* the `WorkflowEntrypoint` class. If `scriptName`
 * is unset we assume the workflow is defined locally (matches Miniflare's
 * `workflow.scriptName ??= workerOpts.core.name` behavior).
 */
const isOwnedByWorker = (entry: WorkflowEntry, workerName: string): boolean =>
  entry.scriptName === undefined || entry.scriptName === workerName;

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
          return { api: { entries: {}, ownedBindings: new Set() } };
        }

        const ownedEntries = entries.filter(([, entry]) => isOwnedByWorker(entry, worker.name));
        const ownedBindings = new Set(ownedEntries.map(([bindingName]) => bindingName));

        // Inform DevRegistryProxy about owned workflows so its dev-registry
        // entry advertises which workflow services this worker hosts. We
        // call into the plugin's API directly at builder-time; it's a sync
        // accumulator. If the dev registry is not enabled (no registry
        // path), the advertisement is harmless.
        if (ownedEntries.length > 0) {
          const proxy = yield* PluginContext.PluginContext.pipe(
            Effect.flatMap((ctx) => ctx.get(DevRegistryProxy)),
          );
          for (const [, entry] of ownedEntries) {
            yield* proxy.api.registerOwnedWorkflow(entry.name, serviceNameForWorkflow(entry.name));
          }
        }

        const api: WorkflowsApi = { entries: workflows, ownedBindings };

        if (ownedEntries.length === 0) {
          // Consumer-only: no engine services to create. The wrapped-binding
          // extension is still needed so consumers can use the wrapped
          // binding pointing at the dev-registry proxy.
          return {
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
            api,
          };
        }

        const storageDiskPath = "disk" in storage ? storage.disk?.path : undefined;
        if (!storageDiskPath) {
          return yield* new ConfigError({
            subtag: "Workflows",
            message:
              "Cannot configure workflows persistence: the Storage service has no disk path.",
            hint: "Configure a disk-backed storage layer (`Storage.layerDisk` or `Storage.layerTemp`).",
            detail: { workflows: ownedEntries.map(([name]) => name) },
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

        const engineServices: Array<WorkerdConfig.Service> = ownedEntries.map(
          ([bindingName, workflow]): WorkerdConfig.Service => ({
            name: serviceNameForWorkflow(workflow.name),
            worker: {
              compatibilityDate: "2024-10-22",
              compatibilityFlags: ["experimental", ...(workflow.compatibilityFlags ?? [])],
              modules: formatInternalWorkerModules(WorkflowsBindingWorker),
              durableObjectNamespaces: [
                {
                  className: "Engine",
                  enableSql: true,
                  uniqueKey: encodeURIComponent(workflow.name),
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
                    name: USER_WORKER_SERVICE_NAME,
                    entrypoint: workflow.className,
                  },
                },
                {
                  name: "BINDING_NAME",
                  json: JSON.stringify(bindingName),
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
          }),
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
          api,
        };
      }),
    );
  }),
);

const serviceNameForWorkflow = (workflowName: string) => `workflows:${workflowName}`;

const wrapBinding = (
  bindingName: string,
  innerService: WorkerdConfig.ServiceDesignator,
): WorkerdConfig.Worker_Binding => ({
  name: bindingName,
  wrapped: {
    moduleName: WORKFLOWS_WRAPPED_BINDING_MODULE,
    innerBindings: [{ name: "binding", service: innerService }],
  },
});

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
export const local = (
  bindingName: string,
): PluginContext.BindingHook<Workflows | DevRegistryProxy> =>
  PluginContext.use((context) =>
    Effect.gen(function* () {
      const workflows = yield* context.get(Workflows);
      const entry = workflows.api.entries[bindingName];
      if (!entry) {
        return yield* new ConfigError({
          subtag: "Workflows",
          message: `No workflow entry was provided for binding "${bindingName}".`,
          hint: `Add an entry for "${bindingName}" to \`worker.workflows\`.`,
          detail: { bindingName },
        });
      }
      if (workflows.api.ownedBindings.has(bindingName)) {
        return wrapBinding(bindingName, {
          name: serviceNameForWorkflow(entry.name),
          entrypoint: "WorkflowBinding",
        });
      }
      // Consumer: route through the dev-registry proxy. The proxy resolves
      // the owner's debug port + `workflows:<name>` service from the dev
      // registry at call time, so the owner can start later (or restart)
      // without breaking the binding shape.
      //
      // `entry.scriptName` is guaranteed defined here: `isOwnedByWorker`
      // returns true when `scriptName` is undefined, so reaching this
      // branch implies a concrete remote script.
      const proxy = yield* context.get(DevRegistryProxy);
      const innerService = yield* proxy.api.registerExternalWorkflow(
        entry.scriptName as string,
        entry.name,
      );
      return wrapBinding(bindingName, innerService);
    }),
  );

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
