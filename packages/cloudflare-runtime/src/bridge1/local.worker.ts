import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { DurableObject } from "cloudflare:workers";
import {
  deserializeRequest,
  serializeResponse,
  type Manager,
  type SerializedRequest,
  type SerializedResponse,
} from "./interface.worker";

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
  manager = new LocalBridgeManager(this.env.USER_WORKER);
  session?: unknown;

  async fetch(request: Request) {
    if (request.method === "POST" && request.url.endsWith("/__configure")) {
      const body = (await request.json()) as { remote: string };
      this.session = newWebSocketRpcSession(body.remote, this.manager);
      return new Response("OK");
    }
    return new Response("Not found", { status: 404 });
  }
}

export class LocalBridgeManager extends RpcTarget implements Manager {
  constructor(readonly fetcher: Fetcher) {
    super();
  }

  async fetch(req: SerializedRequest): Promise<SerializedResponse> {
    console.log("[local] fetching", req.url);
    const response = await this.fetcher.fetch(deserializeRequest(req));
    console.log("[local] response", response);
    return await serializeResponse(response);
  }
}
