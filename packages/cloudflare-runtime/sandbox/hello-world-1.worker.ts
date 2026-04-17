// oxlint-disable no-console

interface Env {
  KV: KVNamespace;
  QUEUE: Queue;
}

export default {
  async fetch() {
    return Response.json({
      message: "Hello, world!",
    });
  },
  queue: async (batch) => {
    for (const message of batch.messages) {
      console.log(message.body);
      message.ack();
    }
  },
} satisfies ExportedHandler<Env>;
