interface Env {
  USER_WORKER: Fetcher;
}

export default {
  async fetch(request, env) {
    return await env.USER_WORKER.fetch(request);
  },
  async queue(batch, env) {
    const result = await env.USER_WORKER.queue(
      batch.queue,
      batch.messages.map((message) => ({
        id: message.id,
        timestamp: message.timestamp,
        attempts: message.attempts,
        body: message.body,
      })),
      batch.metadata,
    );
    if (result.ackAll) {
      batch.ackAll();
    }
    if (result.retryBatch.retry) {
      batch.retryAll({ delaySeconds: result.retryBatch.delaySeconds });
    }
    const messages = Object.groupBy(batch.messages, (message) => message.id);
    for (const id of result.explicitAcks) {
      messages[id]?.forEach((message) => message.ack());
    }
    for (const retryMessage of result.retryMessages) {
      messages[retryMessage.msgId]?.forEach((message) =>
        message.retry({ delaySeconds: retryMessage.delaySeconds }),
      );
    }
  },
  async scheduled(controller, env) {
    await env.USER_WORKER.scheduled({
      cron: controller.cron,
      scheduledTime: new Date(controller.scheduledTime),
    });
  },
} satisfies ExportedHandler<Env>;
