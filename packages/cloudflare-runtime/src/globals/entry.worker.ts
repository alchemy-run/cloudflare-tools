import type { ExportedHandler, Fetcher } from "@cloudflare/workers-types/experimental";
import { makeErrorResponse } from "../internal/response.shared.ts";
import { SystemError } from "../RuntimeError.shared.ts";

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
        return Response.json({ ok: true, result });
      } catch (error) {
        return makeErrorResponse(
          new SystemError({
            subtag: "UserQueueHandler",
            message: `User worker's queue handler threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
            cause: error,
          }),
        );
      }
    }
    return await env.USER_WORKER.fetch(request);
  },
};
