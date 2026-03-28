import { describeProcess } from "direct-process";

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/process") {
      return new Response(describeProcess());
    }

    return new Response("ok");
  },
};
