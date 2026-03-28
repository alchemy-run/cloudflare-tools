import { Buffer } from "node:buffer";
import { getRandomValues } from "node:crypto";

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/test-random") {
      const arr = new Uint32Array(4);
      getRandomValues(arr);
      return new Response(JSON.stringify(Array.from(arr)));
    }

    if (url.pathname === "/test-buffer") {
      const buf = Buffer.from("hello");
      return new Response(buf.toString("base64"));
    }

    if (url.pathname === "/test-process") {
      return new Response(typeof process !== "undefined" ? "OK" : "FAIL");
    }

    if (url.pathname === "/test-buffer-is-buffer") {
      const buf = Buffer.from("test");
      return new Response(Buffer.isBuffer(buf) ? "OK" : "FAIL");
    }

    return new Response("ok");
  },
};
