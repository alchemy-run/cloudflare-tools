export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/node-env") {
      return new Response(process.env.NODE_ENV ?? "undefined");
    }

    if (url.pathname === "/global-node-env") {
      return new Response(global.process.env.NODE_ENV ?? "undefined");
    }

    if (url.pathname === "/globalthis-node-env") {
      return new Response(globalThis.process.env.NODE_ENV ?? "undefined");
    }

    if (url.pathname === "/typeof-process") {
      return new Response(typeof process);
    }

    return new Response("ok");
  },
};
