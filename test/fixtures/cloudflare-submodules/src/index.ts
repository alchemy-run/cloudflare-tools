// Test that various cloudflare:* submodules are preserved as external imports
import { DurableObject } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";

export class MyDO extends DurableObject {
  override async fetch() {
    return new Response("do ok");
  }
}

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/check-types") {
      return new Response(
        JSON.stringify({
          hasDurableObject: typeof DurableObject,
          hasConnect: typeof connect,
        }),
      );
    }

    return new Response("ok");
  },
};
