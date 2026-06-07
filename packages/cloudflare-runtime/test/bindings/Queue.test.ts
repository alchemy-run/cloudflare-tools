import { assert, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "../../src/bindings/queue/Queue.ts";
import { localRuntimeLayer, startTestWorker, waitForRegistryEntry } from "../helpers/runtime.ts";

// Combined producer + consumer worker. The `queue()` handler records every
// delivered message into a module-global array, which the test reads back via
// `GET /received`. Messages whose body carries `failUntil` are retried while
// `attempts < failUntil`, letting tests drive retry / dead-letter behaviour.
const QUEUE_SCRIPT = `
delete Date.prototype.toJSON; // so JSON.stringify reaches the replacer for Date
const received = (globalThis.__received ??= []);
function replacer(_, value) {
  if (value instanceof ArrayBuffer) {
    return { $type: "ArrayBuffer", value: Array.from(new Uint8Array(value)) };
  }
  if (value instanceof Date) {
    return { $type: "Date", value: value.getTime() };
  }
  return value;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/send") {
      const { binding, body, options } = await request.json();
      try {
        await env[binding].send(body, options);
        return new Response(null, { status: 204 });
      } catch (e) {
        return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
      }
    }
    if (url.pathname === "/sendBatch") {
      const { binding, messages } = await request.json();
      await env[binding].sendBatch(messages);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/sendTypes") {
      await env.QUEUE.send("msg-text", { contentType: "text" });
      await env.QUEUE.send([{ message: "msg-json" }], { contentType: "json" });
      await env.QUEUE.send(new Uint8Array([0, 1, 2, 3]), { contentType: "bytes" });
      await env.QUEUE.send(new Date(1600000000000), { contentType: "v8" });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/received") {
      return new Response(JSON.stringify(received, replacer), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      received.push({
        queue: batch.queue,
        id: message.id,
        attempts: message.attempts,
        body: message.body,
      });
      if (
        message.body &&
        typeof message.body === "object" &&
        typeof message.body.failUntil === "number" &&
        message.attempts < message.body.failUntil
      ) {
        message.retry();
      }
    }
  },
};
`;

interface Received {
  queue: string;
  id: string;
  attempts: number;
  body: unknown;
}

const pollReceived = (
  fetch: (path: string, init?: RequestInit) => Effect.Effect<Response>,
  predicate: (received: ReadonlyArray<Received>) => boolean,
  timeoutMs = 10_000,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    let received: ReadonlyArray<Received> = [];
    while (Date.now() < deadline) {
      const res = yield* fetch("/received");
      received = (yield* Effect.promise(() => res.json())) as ReadonlyArray<Received>;
      if (predicate(received)) {
        return received;
      }
      yield* Effect.sleep("50 millis");
    }
    return received;
  });

layer(localRuntimeLayer, { excludeTestServices: true })("Queues binding", (it) => {
  it.effect("delivers single messages and batches to the consumer", () =>
    Effect.gen(function* () {
      const { fetch } = yield* startTestWorker({
        name: "queues-basic",
        compatibilityDate: "2024-11-20",
        compatibilityFlags: [],
        modules: [{ name: "main.js", type: "ESModule", content: QUEUE_SCRIPT }],
        bindings: [Queue.binding({ binding: "QUEUE", queueName: "basic-queue" })],
        queueConsumers: [{ queueName: "basic-queue", maxBatchTimeout: 0 }],
      });

      yield* fetch("/send", {
        method: "POST",
        body: JSON.stringify({ binding: "QUEUE", body: "hello" }),
      });
      yield* fetch("/sendBatch", {
        method: "POST",
        body: JSON.stringify({ binding: "QUEUE", messages: [{ body: "a" }, { body: "b" }] }),
      });

      const received = yield* pollReceived(fetch, (r) => r.length >= 3);
      expect(received.length).toBe(3);
      const bodies = received.map((message) => message.body).sort();
      expect(bodies).toEqual(["a", "b", "hello"]);
      for (const message of received) {
        expect(message.queue).toBe("basic-queue");
        expect(message.attempts).toBe(1);
        expect(message.id).toMatch(/^[0-9a-f]{32}$/);
      }
    }),
  );

  it.effect("supports text, json, bytes and v8 content types", () =>
    Effect.gen(function* () {
      const { fetch } = yield* startTestWorker({
        name: "queues-content-types",
        compatibilityDate: "2024-11-20",
        compatibilityFlags: [],
        modules: [{ name: "main.js", type: "ESModule", content: QUEUE_SCRIPT }],
        bindings: [Queue.binding({ binding: "QUEUE", queueName: "types-queue" })],
        queueConsumers: [{ queueName: "types-queue", maxBatchTimeout: 0 }],
      });

      yield* fetch("/sendTypes", { method: "POST" });

      const received = yield* pollReceived(fetch, (r) => r.length >= 4);
      const bodies = received.map((message) => message.body);
      expect(bodies).toContainEqual("msg-text");
      expect(bodies).toContainEqual([{ message: "msg-json" }]);
      expect(bodies).toContainEqual({ $type: "ArrayBuffer", value: [0, 1, 2, 3] });
      expect(bodies).toContainEqual({ $type: "Date", value: 1600000000000 });
    }),
  );

  it.effect("retries a message until it is acked", () =>
    Effect.gen(function* () {
      const { fetch } = yield* startTestWorker({
        name: "queues-retry",
        compatibilityDate: "2024-11-20",
        compatibilityFlags: [],
        modules: [{ name: "main.js", type: "ESModule", content: QUEUE_SCRIPT }],
        bindings: [Queue.binding({ binding: "QUEUE", queueName: "retry-queue" })],
        queueConsumers: [{ queueName: "retry-queue", maxBatchTimeout: 0, maxRetries: 2 }],
      });

      yield* fetch("/send", {
        method: "POST",
        body: JSON.stringify({ binding: "QUEUE", body: { failUntil: 2 } }),
      });

      const received = yield* pollReceived(fetch, (r) => r.some((m) => m.attempts === 2));
      const attempts = received.map((message) => message.attempts).sort();
      expect(attempts).toEqual([1, 2]);
      // Same message id is redelivered on retry.
      expect(new Set(received.map((message) => message.id)).size).toBe(1);
    }),
  );

  it.effect("moves messages to a dead letter queue after exhausting retries", () =>
    Effect.gen(function* () {
      const { fetch } = yield* startTestWorker({
        name: "queues-dlq",
        compatibilityDate: "2024-11-20",
        compatibilityFlags: [],
        modules: [{ name: "main.js", type: "ESModule", content: QUEUE_SCRIPT }],
        bindings: [Queue.binding({ binding: "QUEUE", queueName: "bad" })],
        queueConsumers: [
          { queueName: "bad", maxBatchTimeout: 0, maxRetries: 0, deadLetterQueue: "dlq" },
          { queueName: "dlq", maxBatchTimeout: 0, maxRetries: 0 },
        ],
      });

      yield* fetch("/send", {
        method: "POST",
        body: JSON.stringify({ binding: "QUEUE", body: { failUntil: 99 } }),
      });

      const received = yield* pollReceived(fetch, (r) => r.some((m) => m.queue === "dlq"));
      expect(received.some((message) => message.queue === "bad")).toBe(true);
      expect(received.some((message) => message.queue === "dlq")).toBe(true);
    }),
  );

  it.effect("applies a delivery delay to messages", () =>
    Effect.gen(function* () {
      const { fetch } = yield* startTestWorker({
        name: "queues-delay",
        compatibilityDate: "2024-11-20",
        compatibilityFlags: [],
        modules: [{ name: "main.js", type: "ESModule", content: QUEUE_SCRIPT }],
        bindings: [Queue.binding({ binding: "QUEUE", queueName: "delay-queue" })],
        queueConsumers: [{ queueName: "delay-queue", maxBatchTimeout: 0 }],
      });

      yield* fetch("/send", {
        method: "POST",
        body: JSON.stringify({
          binding: "QUEUE",
          body: "delayed",
          options: { delaySeconds: 1 },
        }),
      });
      yield* fetch("/send", {
        method: "POST",
        body: JSON.stringify({ binding: "QUEUE", body: "immediate" }),
      });

      // The immediate message arrives well before the delayed one.
      const afterImmediate = yield* pollReceived(fetch, (r) => r.length >= 1, 2_000);
      expect(afterImmediate.map((message) => message.body)).toEqual(["immediate"]);

      const all = yield* pollReceived(fetch, (r) => r.length >= 2, 5_000);
      expect(all.map((message) => message.body).sort()).toEqual(["delayed", "immediate"]);
    }),
  );

  it.effect("rejects messages that exceed the size limit", () =>
    Effect.gen(function* () {
      const { fetch } = yield* startTestWorker({
        name: "queues-size",
        compatibilityDate: "2024-11-20",
        compatibilityFlags: [],
        modules: [{ name: "main.js", type: "ESModule", content: QUEUE_SCRIPT }],
        bindings: [Queue.binding({ binding: "QUEUE", queueName: "size-queue" })],
        queueConsumers: [{ queueName: "size-queue", maxBatchTimeout: 0 }],
      });

      const res = yield* fetch("/send", {
        method: "POST",
        body: JSON.stringify({
          binding: "QUEUE",
          body: "x".repeat(128 * 1000 + 1),
          options: { contentType: "text" },
        }),
      });
      expect(res.status).toBe(500);
      const { error } = (yield* Effect.promise(() => res.json())) as { error: string };
      // workerd surfaces the broker's 413 to the producer as "Payload Too Large".
      expect(error).toMatch(/Payload Too Large|exceeds limit/i);
    }),
  );
});

layer(localRuntimeLayer, { excludeTestServices: true })("Queues binding validation", (it) => {
  it.effect("rejects a queue configured as its own dead letter queue", () =>
    Effect.gen(function* () {
      const error = yield* startTestWorker({
        name: "queues-self-cycle",
        compatibilityDate: "2024-11-20",
        compatibilityFlags: [],
        modules: [{ name: "main.js", type: "ESModule", content: QUEUE_SCRIPT }],
        bindings: [Queue.binding({ binding: "QUEUE", queueName: "loop" })],
        queueConsumers: [{ queueName: "loop", deadLetterQueue: "loop" }],
      }).pipe(Effect.flip);
      assert.equal(error._tag, "ConfigError");
      expect(error.message).toContain("cannot be itself");
    }),
  );
});

// Cross-instance: a producer in one `Runtime` sends to a queue consumed by a
// worker in a *different* `Runtime`. The producer's binding routes through the
// dev-registry proxy to the consumer instance's broker. Both runtimes run
// in-process and communicate via the on-disk dev registry.
const CROSS_PRODUCER_SCRIPT = `
export default {
  async fetch(request, env) {
    await env.QUEUE.send({ hello: "from-producer" });
    return new Response(null, { status: 204 });
  },
};
`;

layer(localRuntimeLayer, {
  excludeTestServices: true,
})("Queues binding cross-instance", (it) => {
  it.effect(
    "delivers messages from a producer instance to a consumer instance",
    () =>
      Effect.gen(function* () {
        // Consumer instance: owns the broker for "cross-queue".
        const consumer = yield* startTestWorker({
          name: "cross-consumer",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [{ name: "main.js", type: "ESModule", content: QUEUE_SCRIPT }],
          bindings: [Queue.binding({ binding: "QUEUE", queueName: "cross-queue" })],
          queueConsumers: [{ queueName: "cross-queue", maxBatchTimeout: 0 }],
        });

        // Producer instance: declares a producer for a queue it does not
        // consume, so the binding routes through the proxy.
        const producer = yield* startTestWorker({
          name: "cross-producer",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [{ name: "main.js", type: "ESModule", content: CROSS_PRODUCER_SCRIPT }],
          bindings: [Queue.binding({ binding: "QUEUE", queueName: "cross-queue" })],
        });

        yield* waitForRegistryEntry({ kind: "queue-consumer", queueName: "cross-queue" });
        yield* producer.fetch("/", { method: "POST" });

        const received = yield* pollReceived(consumer.fetch, (r) => r.length >= 1, 15_000);
        expect(received.length).toBeGreaterThanOrEqual(1);
        expect(received[0]?.queue).toBe("cross-queue");
        expect(received[0]?.body).toEqual({ hello: "from-producer" });
      }),
    { timeout: 60_000 },
  );
});
