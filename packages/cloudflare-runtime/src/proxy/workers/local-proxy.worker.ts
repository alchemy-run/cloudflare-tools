import type { RpcStub } from "capnweb";
import { newWebSocketRpcSession, newWorkersWebSocketRpcResponse } from "capnweb";
import { DurableObject } from "cloudflare:workers";
import {
  CONTROLLER_WEBSOCKET_PATH,
  type ProxyController,
  type WebSocketProxy,
  type WorkerProxy,
} from "../ProxyApi.shared.ts";
import { ProxyError, isProxyControllerRequest } from "./proxy.shared.ts";

interface Env {
  PROXY: ColoLocalActorNamespace;
  PROXY_SECRET: string;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.PROXY.get("global").fetch(request);
  },
};

export class LocalProxy extends DurableObject<Env> {
  workers = new Map<
    string,
    {
      localAddress: string | undefined;
      remoteMain: RpcStub<WebSocketProxy> | undefined;
    }
  >();
  requestQueue = new Map<Request, PromiseWithResolvers<Response>>();
  retryRequestQueue = new Map<Request, PromiseWithResolvers<Response>>();

  async fetch(request: Request) {
    try {
      if (isProxyControllerRequest(request, this.env)) {
        return newWorkersWebSocketRpcResponse(request, this.controller);
      }
      return await this.fetchUserWorker(request);
    } catch (error) {
      return ProxyError.fromUnknown(error).toResponse();
    }
  }

  private controller: ProxyController = {
    listWorkers: () => Array.from(this.workers.keys()),
    registerWorker: (workerName: string) => {
      const existing = this.workers.get(workerName);
      if (existing) return;
      const worker = { localAddress: undefined, remoteMain: undefined };
      this.workers.set(workerName, worker);
    },
    unregisterWorker: (workerName: string) => {
      const worker = this.workers.get(workerName);
      if (!worker) return;
      worker.remoteMain?.[Symbol.dispose]();
      this.workers.delete(workerName);
    },
    setLocalAddress: (workerName: string, address: string) => {
      this.controller.registerWorker(workerName);
      const worker = this.workers.get(workerName)!;
      worker.localAddress = address;
    },
    unsetLocalAddress: (workerName: string, address: string) => {
      this.controller.registerWorker(workerName);
      const worker = this.workers.get(workerName)!;
      if (worker.localAddress !== address) return;
      worker.localAddress = undefined;
    },
    setRemoteAddress: async (workerName: string, address: string) => {
      const url = new URL(address);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = CONTROLLER_WEBSOCKET_PATH;
      const ws = new WebSocket(url.toString());
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => {
          resolve();
        });
        ws.addEventListener("error", (event) => {
          reject(event.error);
        });
      });
      const remoteMain: RpcStub<WebSocketProxy> = newWebSocketRpcSession<WebSocketProxy>(
        ws,
        this.makeLocalMain(() => remoteMain),
        {
          onSendError: (error) => ProxyError.fromUnknown(error),
        },
      );
      this.controller.registerWorker(workerName);
      const worker = this.workers.get(workerName)!;
      worker.remoteMain = remoteMain;
    },
    unsetRemoteAddress: (workerName: string) => {
      const worker = this.workers.get(workerName);
      if (!worker || worker.remoteMain === undefined) return;
      worker.remoteMain?.[Symbol.dispose]();
      worker.remoteMain = undefined;
    },
  };

  private makeLocalMain(remote: () => RpcStub<WebSocketProxy>): WorkerProxy {
    return {
      fetch: async (request: Request): Promise<WorkerProxy.FetchResult> => {
        const response = await this.fetchUserWorker(request);
        if (response.webSocket) {
          const ws = response.webSocket;
          const id = crypto.randomUUID();
          ws.accept({ allowHalfOpen: true });
          ws.addEventListener("message", (event) => {
            remote().webSocketMessage(id, event.data);
          });
          ws.addEventListener("close", (event) => {
            remote().webSocketClose(id, event.code, event.reason, event.wasClean);
          });
          ws.addEventListener("error", (event) => {
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
        const [target] = this.ctx.getWebSockets(id);
        if (!target) {
          return;
        }
        target.send(message);
      },
      webSocketClose: async (id: string, code: number, reason: string) => {
        const [target] = this.ctx.getWebSockets(id);
        if (!target) {
          return;
        }
        target.close(code, reason);
      },
      webSocketError: async (id: string, error: unknown) => {
        console.error("[local] websocket error", id, error);
      },
    };
  }

  private async fetchUserWorker(request: Request): Promise<Response> {
    const promise = Promise.withResolvers<Response>();
    this.requestQueue.set(request, promise);
    this.processRequestQueue();
    return await promise.promise;
  }

  private async processRequestQueue() {
    for (const [request, promise] of this.getOrderedRequestQueue()) {
      try {
        this.requestQueue.delete(request);
        this.retryRequestQueue.delete(request);
        const response = await this.routeUserWorkerRequest(request);
        promise.resolve(response);
      } catch (cause) {
        const error = ProxyError.fromUnknown(cause);
        if (error.retryable) {
          this.retryRequestQueue.set(request, promise);
        } else {
          promise.resolve(error.toResponse());
        }
      }
    }
  }

  private *getOrderedRequestQueue() {
    yield* this.retryRequestQueue;
    yield* this.requestQueue;
  }

  private async routeUserWorkerRequest(request: Request): Promise<Response> {
    const original = new URL(request.url);
    const segments = original.hostname.split(".");
    const name = segments[0] ? decodeURIComponent(segments[0].toLowerCase()) : undefined;
    if (segments.length < 2 || !name) {
      throw new ProxyError({
        message: "The request hostname does not include a worker to route to.",
        hint: "The hostname should be in the format of `<worker-name>.localhost:<port>`, e.g. `my-worker.localhost:1337`.",
        status: 400,
      });
    }
    const worker = this.workers.get(name);
    if (!worker) {
      throw new ProxyError({
        message: `Worker "${name}" not found`,
        status: 502,
      });
    }
    const localAddress = worker.localAddress;
    if (!localAddress) {
      throw new ProxyError({
        message: "Worker address not yet available",
        status: 503,
        retryable: true,
      });
    }
    try {
      const proxied = new URL(original.pathname + original.search, localAddress);
      const headers = new Headers(request.headers);
      headers.set("x-forwarded-host", original.host);
      headers.set("x-forwarded-proto", original.protocol.replace(/:$/, ""));
      return await fetch(proxied, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
      });
    } catch (error) {
      const worker = this.workers.get(name);
      if (!worker || worker.localAddress === localAddress) {
        throw new ProxyError({
          message: `Failed to fetch worker "${name}" (local address: ${localAddress})`,
          status: 502,
          cause: error,
        });
      }
      throw new ProxyError({
        message: "Your worker restarted mid-request.",
        hint: "Try sending the request again. Only GET and HEAD requests are retried automatically.",
        status: 503,
        retryable: request.method === "GET" || request.method === "HEAD",
        cause: error,
      });
    }
  }
}
