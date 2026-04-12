import { newWebSocketRpcSession } from "capnweb";
import { DurableObject } from "cloudflare:workers";

export interface WebSocketBridge {
  message(id: string, message: string | ArrayBuffer): Promise<void>;
  close(id: string, code: number, reason: string, wasClean: boolean): Promise<void>;
  error(id: string, error: unknown): Promise<void>;
}

export interface Bridge {
  fetch(request: Request): Promise<
    | {
        kind: "response";
        response: Response;
      }
    | {
        kind: "upgrade";
        status: number;
        headers: Headers;
        id: string;
      }
    | {
        kind: "error";
        error: Error;
      }
  >;
  websocket: WebSocketBridge;
}

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
  remote?: WebSocketBridge;

  bridge: Bridge = {
    fetch: async (request: Request) => {
      console.log("[local] fetching", request.url);
      try {
        const response = await this.env.USER_WORKER.fetch(request);
        if (response.webSocket) {
          const ws = response.webSocket;
          const id = crypto.randomUUID();
          ws.accept({ allowHalfOpen: true });
          ws.addEventListener("message", (event) => {
            console.log("[local] upstream websocket message", id, event.data);
            this.remote?.message(id, event.data);
          });
          ws.addEventListener("close", (event) => {
            console.log(
              "[local] upstream websocket close",
              id,
              event.code,
              event.reason,
              event.wasClean,
            );
            this.remote?.close(id, event.code, event.reason, event.wasClean);
          });
          ws.addEventListener("error", (event) => {
            console.log("[local] upstream websocket error", id, event.error);
            this.remote?.error(id, event.error);
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
            response: response,
          };
        }
      } catch (error) {
        return {
          kind: "error",
          error: error as Error,
        };
      }
    },
    websocket: {
      message: async (id: string, message: string | ArrayBuffer) => {
        console.log("[local] websocket message", id, message);
        const [target] = this.ctx.getWebSockets(id);
        if (!target) {
          return;
        }
        target.send(message);
      },
      close: async (id: string, code: number, reason: string, wasClean: boolean) => {
        console.log("[local] websocket close", id, code, reason, wasClean);
        const [target] = this.ctx.getWebSockets(id);
        if (!target) {
          return;
        }
        target.close(code, reason);
      },
      error: async (id: string, error: unknown) => {
        console.log("[local] websocket error", id, error);
      },
    },
  };

  async fetch(request: Request) {
    if (request.method === "POST" && request.url.endsWith("/__configure")) {
      const json = await request.json<{ remote: string }>();
      this.remote = newWebSocketRpcSession<WebSocketBridge>(json.remote, this.bridge);
      return new Response("OK");
    }
    return new Response("Not found", { status: 404 });
  }
}
