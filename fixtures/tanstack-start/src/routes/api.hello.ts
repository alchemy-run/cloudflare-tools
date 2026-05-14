import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

export const Route = createFileRoute("/api/hello")({
  server: {
    handlers: {
      GET: async () => {
        const list = await env.TEST.fetch(new Request("http://example.com"));
        return list;
      },
    },
  },
});
