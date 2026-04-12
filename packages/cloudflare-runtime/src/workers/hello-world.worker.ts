// oxlint-disable no-console

interface Env {
  KV: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env) {
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
    } else if (request.url.includes("/kv")) {
      const items = await env.KV.list();
      return Response.json(items);
    } else {
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async start(controller) {
          // Send events
          controller.enqueue(encoder.encode("data: Starting...\n\n"));

          for (let i = 1; i <= 5; i++) {
            await new Promise((r) => setTimeout(r, 500));
            controller.enqueue(encoder.encode(`data: Step ${i} complete\n\n`));
          }

          controller.enqueue(encoder.encode("data: Done!\n\n"));
          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }
  },
};
