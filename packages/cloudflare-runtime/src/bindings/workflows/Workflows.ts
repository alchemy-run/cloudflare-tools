import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as WorkflowsBindingWorker from "worker:./workflows-binding.worker.ts";
import * as WorkflowsWrappedBindingWorker from "worker:./workflows-wrapped-binding.worker.ts";
import { USER_WORKER_SERVICE_NAME } from "../../dev-registry/Constants.shared.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import * as PluginContext from "../../PluginContext.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import { moduleToWorkerd } from "../../RuntimeWorker.ts";
import type { Workflow } from "../../RuntimeWorker.ts";
import type * as WorkerdConfig from "../../workerd/Config.ts";

/**
 * Internal module name used to register the wrapped-binding shim with
 * workerd. Referenced by every workflow binding's `wrapped.moduleName`.
 */
const WRAPPED_BINDING_MODULE_NAME = "cloudflare-runtime:workflows-wrapped-binding";

/**
 * Per-workflow workerd service name. Each workflow gets its own service so
 * the `Engine` Durable Object namespace can have a stable, isolated
 * `uniqueKey`. Mirrors miniflare's `getUserBindingServiceName` convention.
 */
const getWorkflowServiceName = (workflowId: string) => `workflows:${workflowId}`;

/**
 * `uniqueKey` for the `Engine` DO namespace inside the per-workflow engine
 * service. Must differ across workflows or workerd will refuse to start
 * with duplicate DO namespaces.
 */
const getEngineUniqueKey = (workflowId: string) => `cloudflare-runtime-workflows-${workflowId}`;

export class Workflows extends Plugin.Service<Workflows, Record<string, Workflow>>()(
  "cloudflare-runtime/plugin/Workflows",
) {}

export const WorkflowsLive = Layer.succeed(
  Workflows,
  Workflows.of(
    PluginContext.useSync(({ worker }) => {
      const workflows = worker.workflows ?? {};
      const entries = Object.entries(workflows);
      if (entries.length === 0) {
        return { api: {} };
      }

      const services: Array<WorkerdConfig.Service> = entries.map(([workflowId, workflow]) => ({
        name: getWorkflowServiceName(workflowId),
        worker: {
          // Pinned to match the date used by miniflare's workflows plugin —
          // the engine relies on runtime features stabilized by this date.
          compatibilityDate: "2024-10-22",
          compatibilityFlags: ["experimental", ...(workflow.compatibilityFlags ?? [])],
          modules: WorkflowsBindingWorker.modules.map(moduleToWorkerd),
          durableObjectNamespaces: [
            {
              className: "Engine",
              enableSql: true,
              uniqueKey: getEngineUniqueKey(workflowId),
              preventEviction: true,
            },
          ],
          // Reuse the runtime's global storage disk. workerd namespaces DO
          // data by `uniqueKey`, so the engine DOs stay isolated from the
          // user worker's own DOs and from sibling workflows.
          durableObjectStorage: { localDisk: "storage" },
          bindings: [
            { name: "ENGINE", durableObjectNamespace: { className: "Engine" } },
            {
              name: "USER_WORKFLOW",
              service: {
                name: USER_WORKER_SERVICE_NAME,
                entrypoint: workflow.className,
              },
            },
            { name: "BINDING_NAME", json: JSON.stringify(workflowId) },
            ...(workflow.stepLimit !== undefined
              ? [{ name: "STEP_LIMIT", json: JSON.stringify(workflow.stepLimit) }]
              : []),
          ],
        },
      }));

      return {
        services,
        extensions: [
          {
            modules: [
              {
                name: WRAPPED_BINDING_MODULE_NAME,
                internal: true,
                esModule: WorkflowsWrappedBindingWorker.modules[0].content as string,
              },
            ],
          },
        ],
        api: workflows,
      };
    }),
  ),
);

/**
 * Bind a workflow defined in `worker.workflows` as `name`.
 *
 * `workflowId` is the key under `worker.workflows`; the wrapped binding
 * routes calls to the corresponding per-workflow engine service.
 */
export const binding = (name: string, workflowId: string): BindingHook<Workflows> =>
  Plugin.use(Workflows, (workflows) =>
    workflows.api[workflowId]
      ? Effect.succeed({
          name,
          wrapped: {
            moduleName: WRAPPED_BINDING_MODULE_NAME,
            innerBindings: [
              {
                name: "binding",
                service: {
                  name: getWorkflowServiceName(workflowId),
                  entrypoint: "WorkflowBinding",
                },
              },
            ],
          },
        })
      : Effect.fail(
          new ConfigError({
            subtag: "WorkflowMissing",
            message: `No workflow was provided for binding "${name}" (id: ${workflowId}).`,
            hint: `Add an entry for "${workflowId}" to \`worker.workflows\`.`,
            detail: { bindingName: name, workflowId },
          }),
        ),
  );
