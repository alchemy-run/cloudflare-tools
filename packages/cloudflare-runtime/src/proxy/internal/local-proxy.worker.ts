import type { RpcStub } from "capnweb";
import { newWebSocketRpcSession } from "capnweb";
import { DurableObject } from "cloudflare:workers";
import {
  LOCAL_CONFIGURE_PATH,
  REMOTE_WEBSOCKET_PATH,
  type ControllerMessage,
  type WebSocketProxy,
  type WorkerProxy,
} from "../ProxyApi.ts";

interface Env {
  BRIDGE: ColoLocalActorNamespace;
}

export default {
  fetch: async (request: Request, env: Env) => {
    return env.BRIDGE.get("global").fetch(request);
  },
};

export class LocalProxy extends DurableObject<Env> {
  private workers: Record<
    string,
    {
      local?: string;
      remote?: RpcStub<WorkerProxy>;
    }
  > = {};

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
    const message = await request.json<ControllerMessage>();
    this.workers[message.worker] ??= {};
    switch (message._tag) {
      case "Local.Set": {
        this.workers[message.worker].local = message.address;
        break;
      }
      case "Local.Unset": {
        this.workers[message.worker].local = undefined;
        break;
      }
      case "Remote.Set": {
        if (this.workers[message.worker].remote) {
          this.workers[message.worker].remote?.[Symbol.dispose]();
          this.workers[message.worker].remote = undefined;
        }
        this.workers[message.worker].remote = await this.connectToRemote(message.address);
        break;
      }
      case "Remote.Unset": {
        this.workers[message.worker].remote?.[Symbol.dispose]();
        this.workers[message.worker].remote = undefined;
        break;
      }
    }
    return new Response("OK");
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
      const original = new URL(request.url);
      const segments = original.hostname.split(".");
      const name = segments[0];
      console.log("[local] processing queue", {
        name,
        original: original.toString(),
        local: this.workers[name]?.local,
      });
      if (segments.length < 2 || !name) {
        this.queue.delete(request);
        this.retryQueue.delete(request);
        return promise.resolve(new Response("Invalid request", { status: 400 }));
      }
      const local = this.workers[name]?.local;
      if (!local) {
        continue;
      }
      this.queue.delete(request);
      this.retryQueue.delete(request);
      const proxied = new URL(original.pathname + original.search, local);
      this.ctx.waitUntil(
        fetch(proxied, request)
          .then(promise.resolve)
          .catch((error) => {
            if (this.workers[name]?.local === local) {
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
    const remoteMain: RpcStub<WorkerProxy> = newWebSocketRpcSession<WorkerProxy>(
      ws,
      this.makeLocalMain(() => remoteMain),
    );
    return remoteMain;
  }

  private makeLocalMain(remote: () => RpcStub<WebSocketProxy>): WorkerProxy {
    return {
      fetch: async (request: Request): Promise<WorkerProxy.FetchResult> => {
        console.log("[local] fetching", request.url);
        const response = await this.handleUserWorkerRequest(request);
        if (response.webSocket) {
          const ws = response.webSocket;
          const id = crypto.randomUUID();
          ws.accept({ allowHalfOpen: true });
          ws.addEventListener("message", (event) => {
            console.log("[local] upstream websocket message", id, event.data);
            remote().webSocketMessage(id, event.data);
          });
          ws.addEventListener("close", (event) => {
            console.log(
              "[local] upstream websocket close",
              id,
              event.code,
              event.reason,
              event.wasClean,
            );
            remote().webSocketClose(id, event.code, event.reason, event.wasClean);
          });
          ws.addEventListener("error", (event) => {
            console.log("[local] upstream websocket error", id, event.error);
            remote().webSocketError(id, event.error);
          });
          return {
            _tag: "Upgrade",
            status: response.status,
            headers: response.headers,
            id,
          };
        } else {
          return {
            _tag: "Response",
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
}
