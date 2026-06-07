import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as QueueBrokerWorker from "worker:./QueueBroker.worker.ts";
import { SERVICE_USER_WORKER } from "../../internal/constants.ts";
import { formatInternalWorkerModules } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import * as PluginContext from "../../PluginContext.ts";
import { RegistryProxy } from "../../registry/RegistryProxy.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import * as WorkerdConfig from "../../workerd/Config.ts";
import type { QueueConsumer, QueueProducerEntry } from "./QueueOptions.shared.ts";
import {
  BINDING_QUEUE_BROKER,
  BINDING_QUEUE_CONSUMER,
  BINDING_QUEUE_DLQ,
  BINDING_QUEUE_NAME,
  BINDING_QUEUE_PRODUCERS,
  BINDING_QUEUE_USER_WORKER,
} from "./QueueOptions.shared.ts";

const BROKER_COMPATIBILITY_DATE = "2024-10-22";

export class Queue extends Plugin.Service<
  Queue,
  {
    /**
     * Record a producer binding and resolve the workerd `queue` designator it
     * should target: the local broker service when this worker also consumes the
     * queue, otherwise the dev-registry `ExternalQueueProxy` (which forwards to
     * whichever instance consumes the queue).
     */
    readonly registerProducer: (
      props: QueueProducerProps,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
  }
>()("cloudflare-runtime/plugin/Queue") {}

export const QueueLive = Layer.succeed(
  Queue,
  Queue.of(
    Effect.gen(function* () {
      const ctx = yield* PluginContext.PluginContext;
      const proxy = yield* ctx.get(RegistryProxy);
      const consumers = ctx.worker.queueConsumers ?? [];
      const producers: Array<QueueProducerEntry> = [];

      const queueServiceName = (queueName: string): string => `queues:${queueName}`;

      for (const consumer of consumers) {
        if (
          consumer.deadLetterQueue !== undefined &&
          consumer.deadLetterQueue === consumer.queueName
        ) {
          return yield* new ConfigError({
            subtag: "Queue",
            message: `Dead letter queue for queue "${consumer.queueName}" cannot be itself`,
            hint: "Point `deadLetterQueue` at a different queue name.",
            detail: { queueName: consumer.queueName },
          });
        }
        yield* proxy.api.publish({
          kind: "queue-consumer",
          queueName: consumer.queueName,
          service: queueServiceName(consumer.queueName),
        });
      }

      const queueConsumerServiceDesignator = (queueName: string) =>
        consumers.find((consumer) => consumer.queueName === queueName)
          ? Effect.succeed<WorkerdConfig.ServiceDesignator>({ name: queueServiceName(queueName) })
          : proxy.api.subscribe({
              kind: "queue-consumer",
              queueName,
            });

      /**
       * Build the workerd service for a single consumed queue. A single service both
       * hosts the `QueueBrokerObject` Durable Object and exposes the entry `fetch`
       * handler (from `broker.worker.ts`) that producer `queue` bindings target. The
       * entry forwards to the broker via a **same-service** Durable Object binding;
       * splitting the entry and broker into separate services would require a direct
       * cross-service Durable Object reference, which the runtime does not support.
       */
      const queueConsumerService = Effect.fnUntraced(function* (consumer: QueueConsumer) {
        return {
          name: queueServiceName(consumer.queueName),
          worker: {
            compatibilityDate: BROKER_COMPATIBILITY_DATE,
            compatibilityFlags: ["experimental", "service_binding_extra_handlers"],
            modules: formatInternalWorkerModules(QueueBrokerWorker),
            durableObjectNamespaces: [
              {
                className: "QueueBroker",
                // Unique per queue so each broker gets an isolated DO namespace.
                uniqueKey: `cloudflare-runtime-QueueBroker-${consumer.queueName}`,
                preventEviction: true,
              },
            ],
            durableObjectStorage: { inMemory: WorkerdConfig.kVoid },
            bindings: [
              {
                name: BINDING_QUEUE_BROKER,
                durableObjectNamespace: { className: "QueueBroker" },
              },
              { name: BINDING_QUEUE_USER_WORKER, service: { name: SERVICE_USER_WORKER } },
              { name: BINDING_QUEUE_NAME, text: consumer.queueName },
              { name: BINDING_QUEUE_CONSUMER, json: JSON.stringify(consumer) },
              { name: BINDING_QUEUE_PRODUCERS, json: JSON.stringify(producers) },
              ...(consumer.deadLetterQueue
                ? [
                    {
                      name: BINDING_QUEUE_DLQ(consumer.deadLetterQueue),
                      service: yield* queueConsumerServiceDesignator(consumer.deadLetterQueue),
                    },
                  ]
                : []),
            ],
          },
        };
      });

      return {
        api: {
          registerProducer: (props) =>
            Effect.suspend(() => {
              producers.push({ queueName: props.queueName, deliveryDelay: props.deliveryDelay });
              return queueConsumerServiceDesignator(props.queueName);
            }),
        },
        defer: Effect.suspend(() =>
          Effect.forEach(consumers, queueConsumerService, { concurrency: "unbounded" }).pipe(
            Effect.map((services) => ({ services })),
          ),
        ),
      };
    }),
  ),
);

/** Options for a queue producer binding (`env.QUEUE.send()`). */
export interface QueueProducerProps {
  /** Binding name exposed on `env`. */
  readonly binding: string;
  /** Logical name of the queue this binding produces to. */
  readonly queueName: string;
  /** Default delay (seconds, 0-86400) applied to every message. */
  readonly deliveryDelay?: number;
}

/**
 * Bind a queue producer (`env.<binding>.send()` / `.sendBatch()`).
 *
 * Messages are routed to the queue's broker, which lives in whichever instance
 * consumes the queue:
 * - If this worker consumes the queue, the broker is local.
 * - Otherwise the binding routes through the dev-registry proxy to the
 *   consuming instance (or accepts-and-drops if no consumer is running).
 */
export const binding = (
  props: QueueProducerProps,
): PluginContext.BindingHook<Queue | RegistryProxy> =>
  Plugin.use(Queue, (queues) =>
    Effect.map(queues.api.registerProducer(props), (queue) => ({
      name: props.binding,
      queue,
    })),
  );
