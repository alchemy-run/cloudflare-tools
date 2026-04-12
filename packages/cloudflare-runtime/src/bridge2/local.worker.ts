import { DurableObject } from "cloudflare:workers";
import { deserializeHeaders, serializeHeaders } from "../bridge1/interface.worker";
import type { Rpc } from "./rpc.shared";

interface Env {
  USER_WORKER: Fetcher;
  BRIDGE: ColoLocalActorNamespace;
}

export default {
  fetch: async (request: Request, env: Env) => {
    return env.BRIDGE.get("global").fetch(request);
  },
};

export class LocalBridge extends DurableObject<Env> {
  ws?: WebSocket;
  controller: Record<string, ReadableStreamDefaultController<string>> = {};

  async fetch(request: Request) {
    if (request.method === "POST" && request.url.endsWith("/__configure")) {
      const json = await request.json<{ remote: string }>();
      const ws = new WebSocket(json.remote);
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data.toString()) as Rpc.RemoteMessage;
        console.log("[local] received message", message);
        this.handleMessage(ws, message);
      });
      this.ws = ws;
      return new Response("OK");
    }
    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void> {
    console.log("[local] websocket message", message.toString());
    // const json = JSON.parse(message.toString()) as Rpc.RemoteMessage;
    // this.handleMessage(ws, json);
  }

  private handleMessage(ws: WebSocket, message: Rpc.RemoteMessage) {
    function send(message: Rpc.LocalMessage) {
      console.log("[local] sending message", message);
      ws.send(JSON.stringify(message));
    }
    switch (message.type) {
      case "request": {
        const request = new Request(message.data.url, {
          method: message.data.method,
          headers: deserializeHeaders(message.data.headers),
          body: message.data.hasBody
            ? new ReadableStream<string>({
                start: (controller) => {
                  this.controller[message.id] = controller;
                },
              }).pipeThrough(new TextEncoderStream())
            : null,
        });
        this.ctx.waitUntil(
          this.env.USER_WORKER.fetch(request)
            .then(async (response) => {
              console.log("[local] response", response);
              if (response.webSocket !== null) {
                // console.log("[local] accepting websocket", response.webSocket);
                // this.ctx.acceptWebSocket(response.webSocket);
                response.webSocket.addEventListener("message", (event) => {
                  console.log("[local] websocket.message", event);
                  send({
                    type: "websocket.message",
                    id: message.id,
                    data: event.data.toString(),
                  });
                });
                response.webSocket.addEventListener("close", (event) => {
                  send({
                    type: "websocket.close",
                    id: message.id,
                    data: {
                      code: event.code,
                      reason: event.reason,
                    },
                  });
                });
                response.webSocket.addEventListener("error", (event) => {
                  send({
                    type: "websocket.error",
                    id: message.id,
                    data: event.error.toString(),
                  });
                });
              }
              send({
                type: "response",
                id: message.id,
                data: {
                  status: response.status,
                  headers: serializeHeaders(response.headers),
                  hasBody: response.body !== null,
                  hasWebSocket: response.webSocket !== null,
                },
              });
              if (response.body !== null) {
                for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
                  send({
                    type: "response.chunk",
                    id: message.id,
                    data: chunk,
                  });
                }
              }
              send({
                type: "response.end",
                id: message.id,
              });
            })
            .catch((error) => {
              console.error("[local] error", error);
              send({
                type: "response",
                id: message.id,
                data: {
                  status: 500,
                  headers: {},
                  hasBody: false,
                  hasWebSocket: false,
                },
              });
              send({
                type: "response.end",
                id: message.id,
              });
            }),
        );
        return;
      }
      case "request.chunk": {
        this.controller[message.id].enqueue(message.data);
        return;
      }
      case "request.end": {
        this.controller[message.id]?.close();
        delete this.controller[message.id];
        return;
      }
    }
  }
}
