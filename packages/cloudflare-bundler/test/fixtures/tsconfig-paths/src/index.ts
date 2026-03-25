import { greet } from "~lib/greeter";

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/greet") {
      return new Response(greet("world"));
    }

    return new Response("ok");
  },
};
