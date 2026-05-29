import { MODULE_RULES } from "@distilled.cloud/cloudflare-rolldown-plugin/plugins";
import assert from "node:assert";
import * as vite from "vite";
import type { FetchFunctionOptions } from "vite/module-runner";
import { ENVIRONMENT_NAME_HEADER, INIT_PATH } from "./module-runner/constants.shared";

export class DistilledDevEnvironment extends vite.DevEnvironment {
  transport: HotChannel;

  constructor(name: string, config: vite.ResolvedConfig) {
    const transport = new HotChannel();
    super(name, config, {
      hot: true,
      transport,
    });
    this.transport = transport;
  }

  async connect(address: string | URL) {
    const url = new URL(address);
    url.protocol = "ws";
    url.pathname = INIT_PATH;
    const ws = new WebSocket(url, {
      headers: {
        [ENVIRONMENT_NAME_HEADER]: this.name,
      },
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => {
        resolve();
      });
      ws.addEventListener("error", (event) => {
        reject(event.error);
      });
    });
    this.transport.ws = ws;
  }
  override async fetchModule(
    id: string,
    importer?: string,
    options?: FetchFunctionOptions,
  ): Promise<vite.FetchResult> {
    // Additional modules (CompiledWasm, Data, Text)
    if (MODULE_RULES.some((rule) => rule.pattern.test(id))) {
      return {
        externalize: id,
        type: "module",
      };
    }
    return super.fetchModule(id, importer, options);
  }
}

class HotChannel implements vite.HotChannel {
  #ws?: WebSocket;
  queue?: Array<string>;
  listeners = new Map<string, Set<vite.HotChannelListener>>();

  set ws(ws: WebSocket) {
    this.#ws = ws;
    if (this.queue) {
      for (const message of this.queue) {
        this.#ws.send(message);
      }
      this.queue = undefined;
    }
  }

  send(payload: vite.CustomPayload) {
    const json = JSON.stringify(payload);
    if (this.#ws) {
      this.#ws.send(json);
    } else {
      this.queue ??= [];
      this.queue.push(json);
    }
  }

  on(event: string, listener: vite.HotChannelListener) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: vite.HotChannelListener) {
    this.listeners.get(event)?.delete(listener);
  }

  private boundDispatch = this.dispatch.bind(this);

  listen() {
    assert(this.#ws, "WebSocket is not connected");
    this.#ws.addEventListener("message", this.boundDispatch);
  }

  close() {
    assert(this.#ws, "WebSocket is not connected");
    this.#ws.removeEventListener("message", this.boundDispatch);
  }

  private dispatch(event: MessageEvent) {
    const payload = JSON.parse(event.data.toString()) as vite.CustomPayload;

    const listeners = this.listeners.get(payload.event) ?? new Set();
    for (const listener of listeners) {
      listener(payload.data, this.client);
    }
  }

  private client: vite.HotChannelClient = {
    send: (payload) => {
      assert(this.#ws, "WebSocket is not connected");

      this.#ws.send(JSON.stringify(payload));
    },
  };
}
