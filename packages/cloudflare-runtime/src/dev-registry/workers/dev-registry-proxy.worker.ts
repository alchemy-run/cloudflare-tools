import { WorkerEntrypoint } from "cloudflare:workers";
import { USER_WORKER_SERVICE_NAME } from "../Constants.shared.ts";
import type { WorkerdDebugPortConnector } from "./dev-registry-proxy-shared.worker.ts";
import {
  resolveQueueConsumer,
  resolveTarget,
  tailEventsReplacer,
  tailEventsReviver,
  workerNotFoundMessage,
} from "./dev-registry-proxy-shared.worker.ts";

export { createProxyDurableObjectClass, setRegistry } from "./dev-registry-proxy-shared.worker.ts";

const HANDLER_RESERVED_KEYS = new Set([
  "alarm",
  "connect",
  "self",
  "tail",
  "tailStream",
  "test",
  "trace",
  "webSocketClose",
  "webSocketError",
  "webSocketMessage",
]);

interface Env {
  DEV_REGISTRY_DEBUG_PORT: WorkerdDebugPortConnector;
}

interface Props {
  service: string;
  entrypoint: string | undefined;
  // User-supplied `props` from the original service binding / tail consumer.
  // Forwarded to the remote entrypoint via the debug port so they are
  // available as `ctx.props` on the callee.
  userProps?: Record<string, unknown>;
}

function resolve(props: Props, env: Env): Fetcher | null {
  const { service, entrypoint, userProps } = props;
  const target = resolveTarget(service);
  if (!target || !target.debugPortAddress) {
    return null;
  }
  const serviceName =
    entrypoint === null || entrypoint === "default"
      ? target.defaultEntrypointService
      : target.userWorkerService;
  const client = env.DEV_REGISTRY_DEBUG_PORT.connect(target.debugPortAddress);
  return client.getEntrypoint(serviceName, entrypoint ?? undefined, userProps);
}

export class ExternalServiceProxy extends WorkerEntrypoint<Env, Props> {
  _fetcher: Fetcher | null = null;
  _entryFetcher: Fetcher | null = null;

  constructor(ctx: ExecutionContext<Props>, env: Env) {
    super(ctx, env);
    this._fetcher = resolve(ctx.props, env);

    // Separate connection for scheduled: the debug port's EventDispatcher
    // doesn't support runScheduled/runAlarm/queue, so we forward via HTTP.
    const target = resolveTarget(ctx.props.service);
    if (target && target.debugPortAddress) {
      const client = env.DEV_REGISTRY_DEBUG_PORT.connect(target.debugPortAddress);
      this._entryFetcher = client.getEntrypoint(
        ctx.props.service ?? USER_WORKER_SERVICE_NAME,
        ctx.props.entrypoint,
        ctx.props.userProps,
      );
    }

    return new Proxy(this, {
      get(target, prop) {
        if (Reflect.has(target, prop)) {
          return Reflect.get(target, prop);
        }
        if (typeof prop === "string" && HANDLER_RESERVED_KEYS.has(prop)) {
          return undefined;
        }

        if (!target._fetcher) {
          throw new Error(workerNotFoundMessage(ctx.props.service));
        }
        return Reflect.get(target._fetcher, prop);
      },
    });
  }

  fetch(request: Request): Promise<Response> | Response {
    if (!this._fetcher) {
      return new Response(workerNotFoundMessage(this.ctx.props.service), {
        status: 503,
      });
    }
    return this._fetcher.fetch(request);
  }

  async scheduled(controller: ScheduledController) {
    if (!this._entryFetcher) {
      throw new Error(workerNotFoundMessage(this.ctx.props.service));
    }
    const params = new URLSearchParams();
    if (controller.cron) {
      params.set("cron", controller.cron);
    }
    if (controller.scheduledTime) {
      params.set("time", String(controller.scheduledTime));
    }
    const response = await this._entryFetcher.fetch(
      new Request(`http://localhost/cdn-cgi/handler/scheduled?${params}`, {
        headers: { "MF-Route-Override": this.ctx.props.service },
      }),
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Scheduled handler returned HTTP ${response.status}: ${body}`);
    }
  }

  // Forward tail events to the remote worker via RPC.
  // Events with rpcMethod==="tail" are filtered out to prevent infinite
  // recursion (the remote tail() call would itself produce a tail event).
  tail(events: Array<TraceItem>) {
    if (!this._fetcher) {
      return;
    }
    const filtered = events.filter(
      (e) => (e.event as { rpcMethod?: string } | null)?.rpcMethod !== "tail",
    );
    if (filtered.length === 0) {
      return;
    }
    try {
      const serializedEvents = JSON.parse(
        JSON.stringify(filtered, tailEventsReplacer),
        tailEventsReviver,
      );
      // @ts-expect-error .tail is not in the `Fetcher` type but it's a valid RPC call
      return this._fetcher.tail(serializedEvents);
    } catch (e) {
      console.warn(
        `[dev-registry] Failed to forward tail events to "${
          this.ctx.props.service
        }": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

interface QueueProxyProps {
  queueName: string;
}

/**
 * Proxy entrypoint that forwards a producer's `send()`/`sendBatch()` calls to
 * the queue's broker living in another `cloudflare-runtime`/`wrangler dev`
 * process. workerd converts the queue binding into HTTP requests targeting
 * this entrypoint; we resolve the consuming instance from the dev registry by
 * queue name and forward the request over its debug port.
 *
 * If no consumer is currently registered we accept and drop the message
 * (mirroring local Queues behaviour when a queue has no consumer), returning
 * empty backlog metrics so the producer's `send()` resolves successfully.
 */
export class ExternalQueueProxy extends WorkerEntrypoint<Env, QueueProxyProps> {
  fetch(request: Request): Promise<Response> | Response {
    const { queueName } = this.ctx.props;
    const target = resolveQueueConsumer(queueName);
    if (!target) {
      return Response.json({
        metadata: {
          metrics: { backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: 0 },
        },
      });
    }
    const client = this.env.DEV_REGISTRY_DEBUG_PORT.connect(target.debugPortAddress);
    return client.getEntrypoint(target.serviceName).fetch(request);
  }
}

interface WorkflowProxyProps {
  scriptName: string;
  workflowName: string;
}

function workflowNotFoundMessage(scriptName: string, workflowName: string): string {
  return `Workflow "${workflowName}" defined in worker "${scriptName}" not found. Make sure the worker is running locally and exports the workflow.`;
}

function resolveWorkflow(props: WorkflowProxyProps, env: Env): Fetcher | null {
  const target = resolveTarget(props.scriptName);
  if (!target || !target.debugPortAddress) {
    return null;
  }
  const serviceName = target.workflowServices?.[props.workflowName];
  if (!serviceName) {
    return null;
  }
  const client = env.DEV_REGISTRY_DEBUG_PORT.connect(target.debugPortAddress);
  return client.getEntrypoint(serviceName, "WorkflowBinding");
}

/**
 * Proxy entrypoint that forwards `WorkflowBinding` RPCs to a workflow's
 * Engine living in another `cloudflare-runtime`/`wrangler dev` process.
 * Resolves the remote workerd service via the dev registry's
 * `workflowServices` map so we connect directly to the workflow service
 * (rather than the user worker).
 */
export class ExternalWorkflowProxy extends WorkerEntrypoint<Env, WorkflowProxyProps> {
  _fetcher: Fetcher | null = null;

  constructor(ctx: ExecutionContext<WorkflowProxyProps>, env: Env) {
    super(ctx, env);
    this._fetcher = resolveWorkflow(ctx.props, env);

    return new Proxy(this, {
      get(target, prop) {
        if (Reflect.has(target, prop)) {
          return Reflect.get(target, prop);
        }
        if (typeof prop === "string" && HANDLER_RESERVED_KEYS.has(prop)) {
          return undefined;
        }
        // Re-resolve on each call: the owner's debugPortAddress can change
        // (e.g. owner restarts), and we don't want to cache a dead fetcher.
        const fetcher = resolveWorkflow(ctx.props, env);
        if (!fetcher) {
          throw new Error(workflowNotFoundMessage(ctx.props.scriptName, ctx.props.workflowName));
        }
        return Reflect.get(fetcher, prop);
      },
    });
  }

  fetch(request: Request): Promise<Response> | Response {
    const fetcher = resolveWorkflow(this.ctx.props, this.env);
    if (!fetcher) {
      return new Response(
        workflowNotFoundMessage(this.ctx.props.scriptName, this.ctx.props.workflowName),
        { status: 503 },
      );
    }
    return fetcher.fetch(request);
  }
}
