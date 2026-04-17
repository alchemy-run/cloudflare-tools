import { DurableObject } from "cloudflare:workers";
import type { RemoteProxyConfig } from "./config.shared.ts";

declare abstract class ColoLocalActorNamespace<
  T extends Rpc.DurableObjectBranded | undefined = undefined,
> {
  get(actorId: string): Fetcher<T>;
}

interface Env {
  PROXY: ColoLocalActorNamespace<RemoteBindingProxy>;
  LOOPBACK: Fetcher;
  OPTIONS: unknown;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const actor = env.PROXY.get("global");
    return await actor.fetch(request);
  },
};

export class RemoteBindingProxy extends DurableObject<Env> {
  private config: RemoteProxyConfig | undefined;

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
      if (!response.ok) {
        throw new Error(`Failed to fetch config: ${response.statusText}`);
      }
      const config = await response.json<RemoteProxyConfig>();
      this.config = config;
      return config;
    });
  }

  private async proxy(request: Request, config: RemoteProxyConfig): Promise<Response> {
    const origin = new URL(request.url);
    const target = new URL(origin.pathname + origin.search, config.url);
    const proxiedHeaders = new Headers(request.headers);
    for (const [key, value] of Object.entries(config.headers)) {
      proxiedHeaders.set(key, value);
    }
    return await fetch(target, new Request(request, { headers: proxiedHeaders }));
  }
}
