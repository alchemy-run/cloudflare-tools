declare const MY_CONSTANT: string;
declare const BUILD_VERSION: number;

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/constant") {
      return new Response(MY_CONSTANT);
    }

    if (url.pathname === "/version") {
      return new Response(String(BUILD_VERSION));
    }

    if (url.pathname === "/node-env") {
      return new Response(process.env.NODE_ENV ?? "undefined");
    }

    return new Response("ok");
  },
};
