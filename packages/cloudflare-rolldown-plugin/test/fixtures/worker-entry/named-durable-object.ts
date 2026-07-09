import { DurableObject } from "cloudflare:workers";

// A worker that exports only a Durable Object class — valid without a
// default export.
export class Counter extends DurableObject {
  async fetch(): Promise<Response> {
    return new Response("counter");
  }
}
