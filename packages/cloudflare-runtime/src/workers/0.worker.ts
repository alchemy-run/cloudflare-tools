import { DurableObject } from "cloudflare:workers";

interface Env {
  BRIDGE: DurableObjectNamespace<RemoteBridge>;
  BRIDGE_SECRET: string;
}

export class RemoteBridge extends DurableObject<Env> {
  queue = new Map<string, WritableStreamDefaultWriter<RpcResponse>>();

  async fetch(request: Request) {
    if (this.isLocalBridgeRequest(request)) {
      const [server, client] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ["local"]);
      return new Response(null, { status: 101, webSocket: client });
    }
    const id = crypto.randomUUID();
    for await (const message of toRequest(id, request)) {
      this.send(message);
    }
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void> {
    const json = JSON.parse(message.toString()) as RpcResponse;
    const writer = this.queue.get(json.id);
    if (!writer) {
      return;
    }
    writer.write(json);
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void | Promise<void> {}

  private isLocalBridgeRequest(request: Request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return false;
    }
    const token = request.headers.get("authorization")?.split(" ")[1];
    if (!token) {
      return false;
    }
    return timingSafeEqual(token, this.env.BRIDGE_SECRET);
  }

  private send(message: RpcRequest) {
    const [local] = this.ctx.getWebSockets("local");
    if (!local) {
      throw new Error("No local bridge connection");
    }
    local.send(JSON.stringify(message));
  }
}

function timingSafeEqual(a: string, b: string) {
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

interface Envelope<Kind extends string, Data> {
  id: string;
  seq: number;
  kind: Kind;
  data: Data;
  done?: boolean;
}

interface RpcRequestHeaders extends Envelope<
  "request.headers",
  {
    url: string;
    method: string;
    headers: Record<string, string | Array<string>>;
    body?: string | null;
  }
> {}

interface RpcRequestBody extends Envelope<"request.body", string> {}

interface RpcRequestEnd extends Envelope<"request.end", null> {}

interface RpcRequestAbort extends Envelope<"request.abort", null> {}

interface RpcResponseHeaders extends Envelope<
  "response.headers",
  {
    status: number;
    headers: Record<string, string | Array<string>>;
  }
> {}

interface RpcResponseBody extends Envelope<"response.body", string> {}

interface RpcResponseEnd extends Envelope<"response.end", null> {}

type RpcRequest = RpcRequestHeaders | RpcRequestBody | RpcRequestEnd | RpcRequestAbort;
type RpcResponse = RpcResponseHeaders | RpcResponseBody | RpcResponseEnd;

async function* toRequest(
  id: string,
  request: Request,
): AsyncGenerator<RpcRequestHeaders | RpcRequestBody | RpcRequestEnd | RpcRequestAbort> {
  let seq = 0;
  yield {
    id,
    seq: seq++,
    kind: "request.headers",
    data: {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: request.body === null ? null : undefined,
    },
  };
  if (request.body) {
    for await (const data of (request.body as ReadableStream<Uint8Array>).pipeThrough(
      new TextDecoderStream(),
    )) {
      yield {
        id,
        seq: seq++,
        kind: "request.body",
        data,
      };
    }
  }
  yield {
    id,
    seq: seq++,
    kind: "request.end",
    data: null,
  };
}

async function toResponse(stream: ReadableStream<RpcResponse>): Promise<Response> {
  let response: Response | undefined;
  let body: WritableStreamDefaultWriter<string> | undefined;
  for await (const message of stream) {
    switch (message.kind) {
      case "response.headers": {
        response ??= new Response(null, {
          status: message.data.status,
          headers: toHeaders(message.data.headers),
        });
        break;
      }
      case "response.body": {
        response.body.write(message.data);
        break;
      }
    }
  }
}

function toHeaders(headers: Record<string, string | Array<string>>): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const v of value) {
        result.append(key, v);
      }
    } else {
      result.set(key, value);
    }
  }
  return result;
}
