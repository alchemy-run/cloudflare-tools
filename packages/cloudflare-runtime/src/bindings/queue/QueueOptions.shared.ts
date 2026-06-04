/**
 * Shared types and constants for the Queues binding. This file is imported by
 * both Node.js plugin code and the internal `.worker.ts` broker, so it must
 * not reference Node.js or Workers-specific APIs.
 */

export type QueueContentType = "text" | "json" | "bytes" | "v8";

export const QUEUE_CONTENT_TYPES: ReadonlyArray<QueueContentType> = ["text", "json", "bytes", "v8"];

/** Options for a queue consumer (the worker's `queue()` handler). */
export interface QueueConsumer {
  /** Logical name of the queue this worker consumes. */
  readonly queueName: string;
  /** Maximum number of messages per batch (0-100, default 5). */
  readonly maxBatchSize?: number;
  /** Maximum seconds to wait before flushing a partial batch (0-60, default 1). */
  readonly maxBatchTimeout?: number;
  /** Maximum number of retries before dropping/dead-lettering (0-100, default 2). */
  readonly maxRetries?: number;
  /** Name of the queue failed messages are moved to after `maxRetries`. */
  readonly deadLetterQueue?: string;
  /** Default delay (seconds, 0-86400) applied to retried messages. */
  readonly retryDelay?: number;
}

/**
 * A producer entry passed to the broker via JSON env. Mirrors
 * {@link QueueProducerOptions} without the binding name.
 */
export interface QueueProducerEntry {
  readonly queueName: string;
  readonly deliveryDelay?: number;
}

/**
 * The wire format for a single message accepted by the broker's `/batch`
 * endpoint. `body` is base64-encoded. `id` and `timestamp` are only present
 * when re-enqueuing onto a dead-letter queue.
 */
export interface QueueIncomingMessage {
  readonly contentType: QueueContentType;
  readonly body: string;
  readonly delaySecs?: number;
  readonly id?: string;
  readonly timestamp?: number;
}

export interface QueuesBatchRequest {
  readonly messages: ReadonlyArray<QueueIncomingMessage>;
}

export const MAX_MESSAGE_SIZE_BYTES = 128 * 1000;
export const MAX_MESSAGE_BATCH_COUNT = 100;
export const MAX_MESSAGE_BATCH_SIZE = (256 + 32) * 1000;
export const MAX_MESSAGE_DELAY_SECS = 86400;

export const DEFAULT_BATCH_SIZE = 5;
export const DEFAULT_BATCH_TIMEOUT = 1; // seconds
export const DEFAULT_RETRIES = 2;

/** Durable Object class name for the queue broker. */
export const QUEUE_BROKER_CLASS = "QueueBrokerObject";

/**
 * Public workerd service name for a queue. This single service both hosts the
 * `QueueBrokerObject` Durable Object and exposes the entry `fetch` handler
 * targeted by producer `queue` bindings (and dead-letter forwards); the entry
 * forwards to the broker via a same-service Durable Object binding. Registered
 * in the dev registry so producers in other instances can forward here via the
 * proxy.
 */
export const queueServiceName = (queueName: string): string => `queues:queue:${queueName}`;

/** Durable Object id name for the per-queue broker singleton. */
export const QUEUE_BROKER_SINGLETON = "broker";

/** Env binding names used inside the broker / entry workers. */
export const QUEUE_CONSUMER_BINDING = "QUEUE_CONSUMER";
export const QUEUE_PRODUCERS_BINDING = "QUEUE_PRODUCERS";
export const QUEUE_USER_WORKER_BINDING = "USER_WORKER";
export const QUEUE_BROKER_BINDING = "BROKER";
export const QUEUE_NAME_BINDING = "QUEUE_NAME";

/** Name of the service binding the broker uses to forward to a dead-letter queue. */
export const queueDeadLetterBindingName = (queueName: string): string => `DLQ:${queueName}`;
