export type SubscriberEntry =
  | SubscriberEntry.Worker
  | SubscriberEntry.DurableObject
  | SubscriberEntry.QueueConsumer
  | SubscriberEntry.Workflow;

export declare namespace SubscriberEntry {
  export interface Worker {
    readonly kind: "worker";
    readonly scriptName: string;
    readonly entrypoint?: string;
    readonly props?: Record<string, unknown>;
  }
  export interface DurableObject {
    readonly kind: "durable-object";
    readonly scriptName: string;
    readonly className: string;
    readonly uniqueKey: string;
  }
  export interface QueueConsumer {
    readonly kind: "queue-consumer";
    readonly queueName: string;
  }
  export interface Workflow {
    readonly kind: "workflow";
    readonly scriptName: string;
    readonly workflowName: string;
  }
}

export interface RegistryEntry {
  readonly scriptName: string;
  readonly debugPortAddress: string;
  readonly services: [RegistryService.Worker, ...Array<RegistryService>];
}

export type RegistryService =
  | RegistryService.Worker
  | RegistryService.DurableObject
  | RegistryService.QueueConsumer
  | RegistryService.Workflow;

export declare namespace RegistryService {
  export interface Worker {
    readonly kind: "worker";
    readonly fetchService: string;
    readonly rpcService: string;
  }
  export interface DurableObject {
    readonly kind: "durable-object";
    readonly className: string;
    readonly uniqueKey: string;
    readonly service: string;
  }
  export interface QueueConsumer {
    readonly kind: "queue-consumer";
    readonly queueName: string;
    readonly service: string;
  }
  export interface Workflow {
    readonly kind: "workflow";
    readonly workflowName: string;
    readonly service: string;
  }
}

export type ResolvedService<T extends SubscriberEntry = SubscriberEntry> = Extract<
  RegistryService,
  { kind: T["kind"] }
> & {
  readonly scriptName: string;
  readonly debugPortAddress: string;
};

export interface ResolvedServiceMap {
  [key: string]: ResolvedService;
}

export const registryServiceKey = (entry: ResolvedService | SubscriberEntry) => {
  switch (entry.kind) {
    case "worker":
      return `worker:${entry.scriptName}` as const;
    case "durable-object":
      return `durable-object:${entry.scriptName}:${entry.className}` as const;
    case "queue-consumer":
      return `queue-consumer:${entry.queueName}` as const;
    case "workflow":
      return `workflow:${entry.scriptName}:${entry.workflowName}` as const;
  }
};
