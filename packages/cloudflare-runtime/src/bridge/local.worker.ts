import type { RpcStub } from "capnweb";
import { newWebSocketRpcSession } from "capnweb";
import { DurableObject } from "cloudflare:workers";
import {
  LOCAL_CONFIGURE_PATH,
  REMOTE_WEBSOCKET_PATH,
  type Bridge,
  type ProxyControllerMessage,
  type WebSocketBridge,
} from "./api.shared";

interface Env {
  BRIDGE: ColoLocalActorNamespace;
}

export default {
  fetch: async (request: Request, env: Env) => {
    return env.BRIDGE.get("global").fetch(request);
  },
};

export class LocalBridge extends DurableObject<Env> {
  private remote?: RpcStub<WebSocketBridge>;
  private local?: string;
  private queue = new Map<Request, PromiseWithResolvers<Response>>();
  private retryQueue = new Map<Request, PromiseWithResolvers<Response>>();

  async fetch(request: Request) {
    if (request.method === "POST" && request.url.endsWith(LOCAL_CONFIGURE_PATH)) {
      try {
        return await this.handleProxyControllerRequest(request);
      } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), {
          status: 500,
        });
      }
    }
    return await this.handleUserWorkerRequest(request);
  }

  private async handleProxyControllerRequest(request: Request) {
    const message = await request.json<ProxyControllerMessage>();
    switch (message.type) {
      case "local.set": {
        this.local = message.value;
        break;
      }
      case "local.unset": {
        this.local = undefined;
        break;
      }
      case "remote.set": {
        this.remote = await this.connectToRemote(message.value);
        break;
      }
      case "remote.unset": {
        this.remote?.[Symbol.dispose]();
        this.remote = undefined;
        break;
      }
    }
    return new Response("OK");
  }

  private async connectToRemote(remote: string) {
    const url = new URL(remote);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = REMOTE_WEBSOCKET_PATH;
    const ws = new WebSocket(url.toString());
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => {
        resolve();
      });
      ws.addEventListener("error", (event) => {
        reject(event.error);
      });
    });
    return newWebSocketRpcSession<WebSocketBridge>(ws, this.localMain);
  }

  private handleUserWorkerRequest(request: Request) {
    const promise = Promise.withResolvers<Response>();
    this.queue.set(request, promise);
    this.processQueue();
    return promise.promise;
  }

  private *getOrderedQueue() {
    yield* this.retryQueue;
    yield* this.queue;
  }

  private processQueue() {
    for (const [request, promise] of this.getOrderedQueue()) {
      const local = this.local;
      if (!local) {
        break;
      }
      this.queue.delete(request);
      this.retryQueue.delete(request);
      const original = new URL(request.url);
      const proxied = new URL(original.pathname + original.search, local);
      this.ctx.waitUntil(
        fetch(proxied, request)
          .then(promise.resolve)
          .catch((error) => {
            if (this.local === local) {
              promise.reject(error);
              return;
            }
            if (request.method === "GET" || request.method === "HEAD") {
              this.retryQueue.set(request, promise);
            } else {
              promise.resolve(
                new Response(
                  "Your worker restarted mid-request. Please try sending the request again. Only GET or HEAD requests are retried automatically.",
                  {
                    status: 503,
                    headers: { "Retry-After": "0" },
                  },
                ),
              );
            }
          }),
      );
    }
  }

  private readonly localMain: Bridge = {
    fetch: async (request: Request) => {
      console.log("[local] fetching", request.url);
      const response = await this.handleUserWorkerRequest(request);
      if (response.webSocket) {
        const ws = response.webSocket;
        const id = crypto.randomUUID();
        ws.accept({ allowHalfOpen: true });
        ws.addEventListener("message", (event) => {
          console.log("[local] upstream websocket message", id, event.data);
          this.remote?.webSocketMessage(id, event.data);
        });
        ws.addEventListener("close", (event) => {
          console.log(
            "[local] upstream websocket close",
            id,
            event.code,
            event.reason,
            event.wasClean,
          );
          this.remote?.webSocketClose(id, event.code, event.reason, event.wasClean);
        });
        ws.addEventListener("error", (event) => {
          console.log("[local] upstream websocket error", id, event.error);
          this.remote?.webSocketError(id, event.error);
        });
        return {
          kind: "upgrade",
          status: response.status,
          headers: response.headers,
          id,
        };
      } else {
        return {
          kind: "response",
          response,
        };
      }
    },
    webSocketMessage: async (id: string, message: string | ArrayBuffer) => {
      console.log("[local] websocket message", id, message);
      const [target] = this.ctx.getWebSockets(id);
      if (!target) {
        return;
      }
      target.send(message);
    },
    webSocketClose: async (id: string, code: number, reason: string, wasClean: boolean) => {
      console.log("[local] websocket close", id, code, reason, wasClean);
      const [target] = this.ctx.getWebSockets(id);
      if (!target) {
        return;
      }
      target.close(code, reason);
    },
    webSocketError: async (id: string, error: unknown) => {
      console.log("[local] websocket error", id, error);
    },
  };
}
