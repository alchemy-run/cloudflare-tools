// oxlint-disable no-console

export default {
  async fetch(request: Request) {
    console.log("fetch", request.url, request.method, request.headers);
    if (request.url.includes("/ws")) {
      const [server, client] = Object.values(new WebSocketPair());
      server.accept();
      server.addEventListener("open", () => {
        console.log("open");
      });
      server.addEventListener("message", (event) => {
        console.log("message", event.data);
        server.send("Hello, world!");
      });
      server.addEventListener("error", (event) => {
        console.log("error", event.error);
      });
      server.addEventListener("close", () => {
        console.log("close");
      });
      server.send("Hello, world!");
      return new Response(null, { status: 101, webSocket: client });
    } else {
      return new Response("Hello, world!");
    }
  },
};
