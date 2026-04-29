interface Env {
  USER_WORKER: Fetcher;
}

export interface EntryQueuePayload {
  queue: string;
  messages: Array<ServiceBindingQueueMessage>;
  metadata?: MessageBatchMetadata;
}

export default <ExportedHandler<Env>>{
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/cdn-cgi/handler/queue") {
      try {
        const json = await request.json<EntryQueuePayload>();
        const result = await env.USER_WORKER.queue(
          json.queue,
          json.messages.map((message) => ({
            ...message,
            timestamp: new Date(message.timestamp),
          })),
          json.metadata,
        );
        return Response.json(result);
      } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), {
          status: 500,
        });
      }
    }
    return await env.USER_WORKER.fetch(request);
  },
};
