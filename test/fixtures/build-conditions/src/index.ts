// @ts-expect-error — resolved via esbuild conditions
import { platform } from "conditions-lib";

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/platform") {
      return new Response(platform);
    }

    return new Response("ok");
  },
};
