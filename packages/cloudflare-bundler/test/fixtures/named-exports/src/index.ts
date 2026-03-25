import { DurableObject } from "cloudflare:workers";

interface Env {
  MY_DO: DurableObjectNamespace;
}

export class MyDO extends DurableObject {
  override async fetch() {
    return new Response("durable object ok");
  }
}

// Use a class export instead of a bare constant — workerd only accepts
// function/class/ExportedHandler values as module map entries.
// oxlint-disable-next-line typescript/no-extraneous-class
export class WorkerMetadata {
  static version = "1.0.0";
}

export default {
  async fetch(request: Request, _env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/version") {
      return new Response(WorkerMetadata.version);
    }

    return new Response("ok");
  },
};
