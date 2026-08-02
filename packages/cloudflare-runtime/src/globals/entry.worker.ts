import type { ExportedHandler, Fetcher } from "@cloudflare/workers-types/experimental";
import { makeErrorResponse } from "../internal/response.shared.ts";
import { SystemError } from "../RuntimeError.shared.ts";
import { HEADER_CF_BLOB } from "./CfOptions.shared.ts";
import { PATH_SCHEDULED, PATH_SCHEDULED_LEGACY } from "./ScheduledOptions.shared.ts";

interface Env {
  USER_WORKER: Fetcher;
  CF_BLOB: Record<string, unknown>;
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
    // Trigger the user worker's `scheduled()` handler, mirroring Miniflare's
    // `/cdn-cgi/handler/scheduled` route (`workers/core/scheduled.ts`).
    // Like the queue route above, this is always on: the entry socket only
    // binds 127.0.0.1 during local development, so there is no equivalent of
    // Miniflare's `unsafeTriggerHandlers` gate.
    if (url.pathname === PATH_SCHEDULED || url.pathname === PATH_SCHEDULED_LEGACY) {
      try {
        const time = url.searchParams.get("time");
        const result = await env.USER_WORKER.scheduled({
          scheduledTime: time ? new Date(parseInt(time)) : undefined,
          cron: url.searchParams.get("cron") ?? undefined,
        });
        if (url.searchParams.get("format") === "json") {
          return Response.json(result, { status: result.outcome === "ok" ? 200 : 500 });
        }
        return new Response(result.outcome, { status: result.outcome === "ok" ? 200 : 500 });
      } catch (error) {
        return makeErrorResponse(
          new SystemError({
            subtag: "UserScheduledHandler",
            message: `User worker's scheduled handler threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
            cause: error,
          }),
        );
      }
    }
    // Build the user worker's `request.cf` (mirrors Miniflare's
    // `workers/core/entry.worker.ts`): the `MF-CF-Blob` header wins if
    // present, otherwise the configured blob is used, preserving the client's
    // `Accept-Encoding` (defaulting to empty string so `undefined` survives
    // proxying).
    //
    // The blob is parsed here rather than via workerd's `cfBlobHeader` socket
    // option because workerd only provides `request.cf.clientIp` when no
    // `cfBlobHeader` is configured.
    const clientIp = request.cf?.clientIp as string | undefined;
    const clientCfBlobHeader = request.headers.get(HEADER_CF_BLOB);
    const cf: Record<string, unknown> = clientCfBlobHeader
      ? JSON.parse(clientCfBlobHeader)
      : {
          ...env.CF_BLOB,
          clientAcceptEncoding: request.headers.get("Accept-Encoding") ?? "",
        };

    const headers = new Headers(request.headers);
    headers.delete(HEADER_CF_BLOB);
    if (clientIp && !headers.get("CF-Connecting-IP")) {
      // `clientIp` includes the port, e.g. `127.0.0.1:52621` or `[::1]:52621`
      const ipv4Regex = /(?<ip>.*?):\d+/;
      const ipv6Regex = /\[(?<ip>.*?)\]:\d+/;
      const ip = clientIp.match(ipv6Regex)?.groups?.ip ?? clientIp.match(ipv4Regex)?.groups?.ip;
      if (ip) {
        headers.set("CF-Connecting-IP", ip);
      }
    }

    // The experimental and standard workers-types `Request` generics
    // disagree; at runtime these are the same class.
    const userRequest = new Request(request as unknown as Request, { headers, cf });
    return await env.USER_WORKER.fetch(userRequest as unknown as typeof request);
  },
};
