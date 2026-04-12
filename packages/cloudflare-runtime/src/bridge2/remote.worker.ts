import { DurableObject } from "cloudflare:workers";
import { deserializeHeaders, serializeHeaders } from "../bridge1/interface.worker";
import type { Rpc } from "./rpc.shared";

interface Env {
  BRIDGE: DurableObjectNamespace<RemoteBridge>;
}

export default {
  fetch: async (request: Request, env: Env) => {
    return env.BRIDGE.getByName("global").fetch(request);
  },
};

export class RemoteBridge extends DurableObject<Env> {
  queue = new Map<string, PromiseWithResolvers<Response>>();
  controller: Record<string, ReadableStreamDefaultController<string>> = {};

  async fetch(request: Request) {
    if (request.headers.get("upgrade") === "websocket" && request.url.endsWith("/__connect")) {
      const [server, client] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ["local"]);
      return new Response(null, { status: 101, webSocket: client });
    }
    console.log("[remote] fetching", request.url);
    const id = crypto.randomUUID();
    const promise = Promise.withResolvers<Response>();
    this.queue.set(id, promise);
    this.send({
      type: "request",
      id,
      data: {
        url: request.url,
        method: request.method,
        headers: serializeHeaders(request.headers),
        hasBody: request.body !== null,
      },
    });
    if (request.body !== null) {
      for await (const chunk of request.body.pipeThrough(new TextDecoderStream())) {
        this.send({
          type: "request.chunk",
          id,
          data: chunk,
        });
      }
    }
    this.send({
      type: "request.end",
      id,
    });
    return await promise.promise;
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void> {
    const tags = this.ctx.getTags(ws) as ["local"] | ["remote", string];
    if (tags[0] === "remote") {
      this.send({
        type: "websocket.message",
        id: tags[1],
        data: message.toString(),
      });
      return;
    }
    const json = JSON.parse(message.toString()) as Rpc.LocalMessage;
    console.log("[remote] received message", json);
    switch (json.type) {
      case "response": {
        const promise = this.queue.get(json.id);
        if (!promise) {
          return;
        }
        let responseWebSocket: WebSocket | null = null;
        if (json.data.hasWebSocket) {
          const [server, client] = Object.values(new WebSocketPair());
          this.ctx.acceptWebSocket(server, ["remote", json.id]);
          responseWebSocket = client;
        }
        const response = new Response(
          json.data.hasBody
            ? new ReadableStream<string>({
                start: (controller) => {
                  this.controller[json.id] = controller;
                },
              }).pipeThrough(new TextEncoderStream())
            : null,
          {
            status: json.data.status,
            headers: deserializeHeaders(json.data.headers),
            webSocket: responseWebSocket,
          },
        );
        promise.resolve(response);
        this.queue.delete(json.id);
        return;
      }
      case "response.chunk": {
        const controller = this.controller[json.id];
        if (!controller) {
          return;
        }
        controller.enqueue(json.data);
        return;
      }
      case "response.end": {
        this.controller[json.id]?.close();
        delete this.controller[json.id];
        return;
      }
      case "websocket.message": {
        const [target] = this.ctx.getWebSockets(json.id);
        if (!target) {
          return;
        }
        target.send(json.data);
        return;
      }
      case "websocket.close": {
        const [target] = this.ctx.getWebSockets(json.id);
        if (!target) {
          return;
        }
        target.close(json.data.code, json.data.reason);
        return;
      }
    }
  }

  private send(message: Rpc.RemoteMessage) {
    const [local] = this.ctx.getWebSockets("local");
    if (!local) {
      return;
    }
    console.log("[remote] sending message", message);
    local.send(JSON.stringify(message));
  }
}
