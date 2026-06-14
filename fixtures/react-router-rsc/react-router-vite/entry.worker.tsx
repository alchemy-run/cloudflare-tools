import handler from "./entry.rsc.single"

// The distilled Cloudflare worker wrapper expects a `{ fetch }` default export;
// the RSC single-worker handler is a bare (request) => Response function.
export default {
  fetch: (request: Request) => handler(request),
}
