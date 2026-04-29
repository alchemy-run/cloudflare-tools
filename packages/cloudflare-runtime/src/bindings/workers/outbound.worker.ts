import { DurableObject } from "cloudflare:workers";
import type { OutboundConfig, SessionOptions } from "../RemoteConfig.ts";

interface Env {
  PROXY: ColoLocalActorNamespace;
  LOOPBACK: Fetcher;
  OPTIONS: SessionOptions;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const actor = env.PROXY.get("global");
    return await actor.fetch(request);
  },
};

export class RemoteBindingProxy extends DurableObject<Env> {
  private config: OutboundConfig | undefined;

  async fetch(request: Request): Promise<Response> {
    const config = await this.configure();
    const response = await this.proxy(request, config);
    if (response.status === 400) {
      const clone = response.clone();
      const text = await clone.text();
      if (text.includes("Invalid Workers Preview configuration")) {
        const config = await this.configure(true);
        return await this.proxy(request, config);
      }
    }
    return response;
  }

  private configure(force: boolean = false) {
    if (this.config && !force) {
      return Promise.resolve(this.config);
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      this.config = undefined;
      const response = await this.env.LOOPBACK.fetch("http://stub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.env.OPTIONS),
      });
      const json = await response.json<
        { success: true; session: OutboundConfig } | { success: false; error: { message: string } }
      >();
      if (!json.success) {
        throw new Error(`Failed to fetch config: ${response.statusText}`, { cause: json.error });
      }
      this.config = json.session;
      return json.session;
    });
  }

  private async proxy(request: Request, config: OutboundConfig): Promise<Response> {
    const origin = new URL(request.url);
    const target = new URL(origin.pathname + origin.search, config.url);
    const proxiedHeaders = new Headers(request.headers);
    for (const [key, value] of Object.entries(config.headers)) {
      proxiedHeaders.set(key, value);
    }
    return await fetch(target, new Request(request, { headers: proxiedHeaders }));
  }
}
