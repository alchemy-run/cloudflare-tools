import { joinWithRequire } from "./require-path.cjs";

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/join") {
      return new Response(joinWithRequire());
    }

    return new Response("ok");
  },
};
