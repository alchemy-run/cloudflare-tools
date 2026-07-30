declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
  export const waitUntil: (promise: Promise<unknown>) => void;
  /** Minimal structural declaration for the fixture (no @cloudflare/workers-types in `types` to avoid DOM lib conflicts). */
  export abstract class DurableObject<Env = unknown> {
    protected ctx: {
      storage: {
        sql: {
          exec(
            query: string,
            ...bindings: Array<unknown>
          ): {
            toArray(): Array<Record<string, unknown>>;
          };
        };
      };
    };
    protected env: Env;
    constructor(ctx: unknown, env: unknown);
  }
}

/**
 * The INTENDED import seam for wrapping waku's server handler from a custom
 * worker entry: resolved by the waku cloudflare target's vite plugins to
 * `<wakuDirectory>/dist/lib/vite-entries/entry.server.js` (whose default
 * export is the adapter's ExportedHandler). Does not exist yet — part of the
 * missing integration surface this fixture specifies (see README).
 */
declare module "virtual:waku/server-entry" {
  const handler: {
    fetch(request: Request, env: unknown, ctx: unknown): Response | Promise<Response>;
  };
  export default handler;
}
