import { join } from "path";

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/join") {
      return new Response(join("a", "b"));
    }

    return new Response("ok");
  },
};
