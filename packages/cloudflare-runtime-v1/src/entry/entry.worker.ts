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
    }
    return await env.USER_WORKER.fetch(request);
  },
};
