interface FixtureCache {
  match(key: string | Request): Promise<Response | undefined>;
  put(key: string | Request, response: Response): Promise<void>;
  delete(key: string | Request): Promise<boolean>;
}

declare global {
  namespace App {
    interface Platform {
      env?: {
        FIXTURE_SECRET?: string;
        ASSETS?: { fetch(input: Request | string | URL): Promise<Response> };
      };
      ctx?: { waitUntil(promise: Promise<unknown>): void };
      /**
       * Workers Cache API in live mode; the dev stub platform's no-op cache
       * in dev (match never hits) until the cloudflare-runtime Node-side
       * bindings proxy lands.
       */
      caches?: {
        default: FixtureCache;
        open(name: string): Promise<FixtureCache>;
      };
    }
  }
}

export {};
