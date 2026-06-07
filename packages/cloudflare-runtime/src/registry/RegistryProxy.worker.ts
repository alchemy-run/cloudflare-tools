import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  registryServiceKey,
  type ResolvedService,
  type ResolvedServiceMap,
  type SubscriberEntry,
} from "./RegistryTypes.shared.ts";

interface Env {
  REGISTRY_DEBUG_PORT: Env.WorkerdDebugPortConnector;
}

declare namespace Env {
  /**
   * Represents the workerd debug port's ability to open connections to other
   * workerd instances by address. Mirrors the Cap'n Proto RPC interface exposed
   * by the workerd debug port.
   *
   * @see https://github.com/cloudflare/workerd/blob/main/src/workerd/server/server.c++
   */
  interface WorkerdDebugPortConnector {
    connect(address: string): WorkerdDebugPortClient;
  }

  /**
   * A connected debug port client that can resolve service entrypoints and
   * Durable Object actors on a remote workerd instance.
   */
  interface WorkerdDebugPortClient {
    getEntrypoint(service: string, entrypoint?: string, props?: Record<string, unknown>): Fetcher;
    getActor(service: string, entrypoint: string, actorId: string): Fetcher;
  }
}

const HANDLER_RESERVED_KEYS = new Set<string>([
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

export function makeExternalDurableObject(
  subscriber: SubscriberEntry.DurableObject,
): typeof DurableObject<Env> {
  return class ExternalDurableObject extends DurableObject<Env> {
    private resolver: Services.Resolver;

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);

      this.resolver = Services.makeResolver(subscriber, (service) =>
        env.REGISTRY_DEBUG_PORT.connect(service.debugPortAddress).getActor(
          service.service,
          subscriber.className,
          this.ctx.id.toString(),
        ),
      );

      return new Proxy(this, {
        get: (_, prop) => {
          if (Reflect.has(this, prop)) {
            return Reflect.get(this, prop);
          }
          const fetcher = this.resolver.resolve();
          // Return a function-that-throws rather than throwing immediately:
          // workerd probes DO properties (fetch, alarm, etc.) via the get
          // trap, and throwing here would crash those internal checks.
          if (!fetcher) {
            return () => {
              throw new Error(this.notFoundMessage());
            };
          }
          return Reflect.get(fetcher, prop);
        },
      });
    }

    fetch(request: Request): Response | Promise<Response> {
      const fetcher = this.resolver.resolve();
      if (!fetcher) {
        return new Response(this.notFoundMessage(), { status: 503 });
      }
      return fetcher.fetch(request);
    }

    private notFoundMessage() {
      return `Durable Object "${subscriber.className}" defined in worker "${subscriber.scriptName}" not found. Make sure the worker is running locally and exports the class.`;
    }
  };
}

export class ExternalQueueConsumer extends WorkerEntrypoint<Env, SubscriberEntry.QueueConsumer> {
  private resolver = Services.makeResolver(this.ctx.props, (service) =>
    this.env.REGISTRY_DEBUG_PORT.connect(service.debugPortAddress).getEntrypoint(service.service),
  );

  fetch(request: Request): Promise<Response> | Response {
    const fetcher = this.resolver.resolve();
    if (!fetcher) {
      console.warn(
        `[registry] No consumer registered for queue "${this.ctx.props.queueName}". Accepting and dropping message.`,
      );
      return Response.json({
        metadata: {
          metrics: { backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: 0 },
        },
      });
    }
    return fetcher.fetch(request);
  }
}

export class ExternalService extends WorkerEntrypoint<Env, SubscriberEntry.Worker> {
  private rpcResolver: Services.Resolver;
  private fetchResolver: Services.Resolver;

  constructor(ctx: ExecutionContext<SubscriberEntry.Worker>, env: Env) {
    super(ctx, env);

    this.rpcResolver = Services.makeResolver(ctx.props, (service) =>
      env.REGISTRY_DEBUG_PORT.connect(service.debugPortAddress).getEntrypoint(
        service.rpcService,
        ctx.props?.entrypoint,
        ctx.props?.props,
      ),
    );
    this.fetchResolver = Services.makeResolver(ctx.props, (service) =>
      env.REGISTRY_DEBUG_PORT.connect(service.debugPortAddress).getEntrypoint(
        service.fetchService,
        ctx.props?.entrypoint,
        ctx.props?.props,
      ),
    );

    return new Proxy(this, {
      get: (_, prop) => {
        if (Reflect.has(this, prop)) {
          return Reflect.get(this, prop);
        }
        if (typeof prop === "string" && HANDLER_RESERVED_KEYS.has(prop)) {
          return undefined;
        }
        const fetcher = this.rpcResolver.resolve();
        if (!fetcher) {
          throw new Error(this.notFoundMessage());
        }
        return Reflect.get(fetcher, prop);
      },
    });
  }

  fetch(request: Request): Promise<Response> | Response {
    const fetcher = this.fetchResolver.resolve();
    if (!fetcher) {
      return new Response(this.notFoundMessage(), { status: 503 });
    }
    return fetcher.fetch(request);
  }

  async scheduled(controller: ScheduledController) {
    const fetcher = this.fetchResolver.resolve();
    if (!fetcher) {
      throw new Error(this.notFoundMessage());
    }
    const params = new URLSearchParams();
    if (controller.cron) {
      params.set("cron", controller.cron);
    }
    if (controller.scheduledTime) {
      params.set("time", String(controller.scheduledTime));
    }
    const response = await fetcher.fetch(`http://localhost/cdn-cgi/handler/scheduled?${params}`);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Scheduled handler returned HTTP ${response.status}: ${body}`);
    }
  }

  async tail(events: Array<TraceItem>) {
    const fetcher = this.fetchResolver.resolve();
    if (!fetcher) {
      console.warn(
        `[registry] Failed to forward tail events to "${this.ctx.props.scriptName}": worker not found`,
      );
      return;
    }
    // Filter out tail events to prevent infinite recursion (the remote tail() call would itself produce a tail event).
    const filtered = events.filter(
      (item) => !(item.event && "rpcMethod" in item.event && item.event.rpcMethod === "tail"),
    );
    const serializedEvents = JSON.parse(
      JSON.stringify(filtered, ExternalService.tailEventsReplacer),
      ExternalService.tailEventsReviver,
    );
    // @ts-expect-error tail() is not in the `Fetcher` type but it's a valid RPC call
    return await fetcher.tail(serializedEvents);
  }

  private notFoundMessage() {
    return `Worker "${this.ctx.props.scriptName}" not found. Make sure the worker is running locally.`;
  }

  private static SERIALIZED_DATE = "___serialized_date___";
  private static SERIALIZED_BIGINT = "___serialized_bigint___";

  private static tailEventsReplacer(_: string, value: any) {
    if (value instanceof Date) {
      return { [ExternalService.SERIALIZED_DATE]: value.toISOString() };
    } else if (typeof value === "bigint") {
      return { [ExternalService.SERIALIZED_BIGINT]: value.toString() };
    }
    return value;
  }

  private static tailEventsReviver(_: string, value: any) {
    if (value && typeof value === "object") {
      if (ExternalService.SERIALIZED_DATE in value) {
        return new Date(value[ExternalService.SERIALIZED_DATE]);
      } else if (ExternalService.SERIALIZED_BIGINT in value) {
        return BigInt(value[ExternalService.SERIALIZED_BIGINT]);
      }
    }
    return value;
  }
}

export class ExternalWorkflow extends WorkerEntrypoint<Env, SubscriberEntry.Workflow> {
  private resolver: Services.Resolver;

  constructor(ctx: ExecutionContext<SubscriberEntry.Workflow>, env: Env) {
    super(ctx, env);
    this.resolver = Services.makeResolver(ctx.props, (service) =>
      env.REGISTRY_DEBUG_PORT.connect(service.debugPortAddress).getEntrypoint(
        service.service,
        "WorkflowBinding",
      ),
    );

    return new Proxy(this, {
      get: (_, prop) => {
        if (Reflect.has(this, prop)) {
          return Reflect.get(this, prop);
        }
        if (typeof prop === "string" && HANDLER_RESERVED_KEYS.has(prop)) {
          return undefined;
        }
        const fetcher = this.resolver.resolve();
        if (!fetcher) {
          throw new Error(this.notFoundMessage());
        }
        return Reflect.get(fetcher, prop);
      },
    });
  }

  async fetch(request: Request): Promise<Response> {
    const fetcher = this.resolver.resolve();
    if (!fetcher) {
      return new Response(this.notFoundMessage(), { status: 503 });
    }
    return fetcher.fetch(request);
  }

  private notFoundMessage() {
    return `Workflow "${this.ctx.props.workflowName}" defined in worker "${this.ctx.props.scriptName}" not found. Make sure the worker is running locally and exports the workflow.`;
  }
}

export namespace Services {
  let services: ResolvedServiceMap = {};

  export function set(newValue: ResolvedServiceMap): void {
    services = newValue;
  }

  export interface Resolver {
    resolve(): Fetcher | undefined;
  }

  export function makeResolver<T extends SubscriberEntry>(
    subscriber: T,
    toFetcher: (service: ResolvedService<T>) => Fetcher,
  ): Resolver {
    const key = registryServiceKey(subscriber);
    let fetcher: Fetcher | undefined;
    let debugPortAddress: string | undefined;
    return {
      resolve: () => {
        const target = services[key] as ResolvedService<T> | undefined;
        if (!target) {
          fetcher = undefined;
          debugPortAddress = undefined;
          return undefined;
        }
        if (fetcher && debugPortAddress === target.debugPortAddress) {
          return fetcher;
        }
        fetcher = toFetcher(target);
        debugPortAddress = target.debugPortAddress;
        return fetcher;
      },
    };
  }
}
