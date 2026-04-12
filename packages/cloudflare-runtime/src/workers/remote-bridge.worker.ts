import { DurableObject } from "cloudflare:workers";
import { deserializeHeaders, serializeHeaders } from "../bridge1/interface.worker.ts";
import type {
  RpcAbort,
  RpcRequest,
  RpcResponse,
  RpcResponseChunk,
  RpcResponseEnd,
  RpcUpgradeWebSocket,
  RpcWebSocketClose,
  RpcWebSocketMessage,
} from "./rpc.shared.ts";

interface Env {
  REMOTE_BRIDGE: DurableObjectNamespace<RemoteBridge>;
  BRIDGE_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env) {
    return env.REMOTE_BRIDGE.getByName("global").fetch(request);
  },
};

export class RemoteBridge extends DurableObject<Env> {
  queue = new Map<string, PromiseWithResolvers<Response>>();
  responseStreams = new Map<string, WritableStreamDefaultWriter<string>>();

  async fetch(request: Request) {
    if (
      request.headers.get("upgrade") === "websocket" &&
      request.headers.get("authorization") === `Bearer ${this.env.BRIDGE_SECRET}`
    ) {
      const [server, client] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ["local"]);
      return new Response(null, { status: 101, webSocket: client });
    }
    return this.sendRequest(request);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void> {
    const tags = this.ctx.getTags(ws) as ["local"] | ["remote", string];
    if (tags[0] === "remote") {
      const [local] = this.ctx.getWebSockets("local");
      if (!local) {
        return;
      }
      const body: RpcWebSocketMessage = {
        type: "websocket.message",
        id: tags[1],
        data: message.toString(),
      };
      local.send(JSON.stringify(body));
      return;
    }
    const json = JSON.parse(message.toString()) as
      | RpcResponse
      | RpcUpgradeWebSocket
      | RpcWebSocketMessage
      | RpcWebSocketClose
      | RpcResponseChunk
      | RpcResponseEnd;
    switch (json.type) {
      case "response": {
        const promise = this.queue.get(json.id);
        if (!promise) {
          return;
        }
        const headers = deserializeHeaders(json.data.headers);
        if ("body" in json.data) {
          promise.resolve(new Response(json.data.body, { status: json.data.status, headers }));
        } else {
          const stream = new TransformStream<string, string>();
          this.responseStreams.set(json.id, stream.writable.getWriter());
          promise.resolve(
            new Response(stream.readable.pipeThrough(new TextEncoderStream()), {
              status: json.data.status,
              headers,
            }),
          );
        }
        this.queue.delete(json.id);
        break;
      }
      case "response.chunk": {
        const stream = this.responseStreams.get(json.id);
        if (!stream) {
          return;
        }
        stream.write(json.data);
        break;
      }
      case "response.end": {
        const stream = this.responseStreams.get(json.id);
        if (!stream) {
          return;
        }
        stream.close();
        this.responseStreams.delete(json.id);
        break;
      }
      case "websocket.upgrade": {
        const promise = this.queue.get(json.id);
        if (!promise) {
          return;
        }
        const [server, client] = Object.values(new WebSocketPair());
        this.ctx.acceptWebSocket(server, ["remote", json.id]);
        promise.resolve(new Response(null, { status: 101, webSocket: client }));
        break;
      }
      case "websocket.message": {
        const [target] = this.ctx.getWebSockets(json.id);
        if (!target) {
          return;
        }
        target.send(json.data);
        break;
      }
      case "websocket.close": {
        const [target] = this.ctx.getWebSockets(json.id);
        if (!target) {
          return;
        }
        target.close(json.data.code, json.data.reason);
        break;
      }
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void | Promise<void> {
    const tags = this.ctx.getTags(ws) as ["local"] | ["remote", string];
    switch (tags[0]) {
      case "local": {
        this.queue.forEach((promise) =>
          promise.resolve(new Response("Workerd closed the connection", { status: 502 })),
        );
        this.queue.clear();
        const remotes = this.ctx.getWebSockets("remote");
        if (remotes.length > 0) {
          for (const remote of remotes) {
            remote.close(code, reason);
          }
        }
        return;
      }
      case "remote": {
        const [local] = this.ctx.getWebSockets("local");
        if (!local) {
          return;
        }
        const body: RpcWebSocketClose = {
          type: "websocket.close",
          id: tags[1],
          data: { code, reason },
        };
        local.send(JSON.stringify(body));
        return;
      }
    }
  }

  private async sendRequest(request: Request) {
    const [local] = this.ctx.getWebSockets("local");
    if (!local) {
      return new Response("No local bridge connection", { status: 502 });
    }
    const id = crypto.randomUUID();
    const promise = Promise.withResolvers<Response>();
    this.queue.set(id, promise);
    const requestMessage: RpcRequest = {
      type: "request",
      id,
      data: {
        url: request.url,
        method: request.method,
        headers: serializeHeaders(request.headers),
        body: request.body ? await request.text() : null,
      },
    };
    local.send(JSON.stringify(requestMessage));
    request.signal.addEventListener("abort", () => {
      const body: RpcAbort = {
        type: "abort",
        id,
      };
      local.send(JSON.stringify(body));
    });
    this.ctx.waitUntil(promise.promise);
    return promise.promise;
  }
}
