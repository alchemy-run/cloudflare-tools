import { DurableObject } from "cloudflare:workers";

interface Env {
  LOCAL_BRIDGE: DurableObjectNamespace<LocalBridge>;
  BRIDGE_SECRET: string;
}

export class LocalBridge extends DurableObject<Env> {
  ws?: WebSocket;
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (
      url.pathname === "/__configure" &&
      request.method === "POST" &&
      request.headers.get("authorization") === `Bearer ${this.env.BRIDGE_SECRET}`
    ) {
      const body = (await request.json()) as {
        remote: string;
      };
      this.ws = new WebSocket(body.remote);
      return new Response("OK");
    }
    return new Response("Not found", { status: 404 });
  }
}
