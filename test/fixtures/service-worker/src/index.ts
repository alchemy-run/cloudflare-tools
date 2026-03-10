// Service worker format: no default export, uses addEventListener
addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);

  if (url.pathname === "/hello") {
    event.respondWith(new Response("hello from service worker"));
    return;
  }

  event.respondWith(new Response("ok"));
});
