declare global {
  namespace App {
    interface Platform {
      env?: {
        FIXTURE_SECRET?: string;
        ASSETS?: { fetch(input: Request | string | URL): Promise<Response> };
      };
      ctx?: { waitUntil(promise: Promise<unknown>): void };
    }
  }
}

export {};
