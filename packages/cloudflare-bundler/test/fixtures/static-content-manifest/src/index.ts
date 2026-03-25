// @ts-expect-error — __STATIC_CONTENT_MANIFEST is provided by the Workers runtime
import manifest from "__STATIC_CONTENT_MANIFEST";

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/manifest-type") {
      return new Response(typeof manifest);
    }

    return new Response("ok");
  },
};
