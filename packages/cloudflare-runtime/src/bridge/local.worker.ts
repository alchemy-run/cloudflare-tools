import type { RpcStub } from "capnweb";
import { newWebSocketRpcSession } from "capnweb";
import { DurableObject } from "cloudflare:workers";
import {
  LOCAL_CONFIGURE_PATH,
  REMOTE_WEBSOCKET_PATH,
  type Bridge,
  type WebSocketBridge,
} from "./api.shared";

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
  private remote?: RpcStub<WebSocketBridge>;

  async fetch(request: Request) {
    if (request.method === "POST" && request.url.endsWith(LOCAL_CONFIGURE_PATH)) {
      if (this.remote) {
        this.remote[Symbol.dispose]();
      }
      const json = await request.json<{ remote: string }>();
      try {
        this.remote = await this.connectToRemote(json.remote);
        return new Response("OK");
      } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), {
          status: 500,
        });
      }
    }
    return new Response("Not Implemented", { status: 501 });
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

  private readonly localMain: Bridge = {
    fetch: async (request: Request) => {
      console.log("[local] fetching", request.url);
      const response = await this.env.USER_WORKER.fetch(request);
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
          response: response,
        };
      }
    },
    queue: async (name, messages, metadata) => {
      return await this.env.USER_WORKER.queue(name, messages, metadata);
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
