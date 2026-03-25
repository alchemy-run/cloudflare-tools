export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/user-agent") {
      return new Response(navigator.userAgent);
    }

    // Tree-shaking test: when navigator.userAgent is defined as "Cloudflare-Workers",
    // esbuild should be able to eliminate the "browser" branch entirely.
    if (navigator.userAgent === "Cloudflare-Workers") {
      return new Response("workers");
    } else {
      return new Response("browser");
    }
  },
};
