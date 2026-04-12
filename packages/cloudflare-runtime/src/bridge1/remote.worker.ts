import { RpcSession } from "capnweb";
import { DurableObject } from "cloudflare:workers";
import { deserializeResponse, serializeRequest, type Manager } from "./interface.worker";
import { DurableObjectTransport } from "./transport.worker";

interface Env {
  BRIDGE: DurableObjectNamespace<RemoteBridge>;
}

export default {
  fetch: async (request: Request, env: Env) => {
    return env.BRIDGE.getByName("global").fetch(request);
  },
};

export class RemoteBridge extends DurableObject {
  transport?: DurableObjectTransport;
  session?: RpcSession<Manager>;

  async fetch(request: Request) {
    if (request.headers.get("upgrade") === "websocket") {
      const [server, client] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ["local"]);
      this.transport = new DurableObjectTransport(server);
      this.session = new RpcSession<Manager>(this.transport);
      return new Response(null, { status: 101, webSocket: client });
    }
    const main = this.session?.getRemoteMain();
    if (!main) {
      return new Response("Bad Gateway", { status: 502 });
    }
    console.log("[remote] fetching", request.url);
    const response = await main.fetch(await serializeRequest(request));
    console.log("[remote] response", response);
    return deserializeResponse(response);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void> {
    this.transport?.webSocketMessage(ws, message);
  }
}
