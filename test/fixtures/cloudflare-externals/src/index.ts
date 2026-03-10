import { DurableObject } from "cloudflare:workers";

interface Env {
  MY_DO: DurableObjectNamespace;
}

export class MyDO extends DurableObject {
  override async fetch(_request: Request) {
    return new Response("durable object ok");
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/do") {
      const id = env.MY_DO.idFromName("test");
      const stub = env.MY_DO.get(id);
      return stub.fetch(request);
    }

    return new Response("ok");
  },
};
