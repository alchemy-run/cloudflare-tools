import { RpcSession, type RpcStub, type RpcTransport } from "capnweb";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { REMOTE_WEBSOCKET_PATH, type Bridge, type WebSocketBridge } from "./api.shared";

interface Env {
  BRIDGE: DurableObjectNamespace<RemoteBridge>;
  BRIDGE_SECRET: string;
}

export default class extends WorkerEntrypoint<Env> {
  get bridge() {
    return this.env.BRIDGE.getByName("global");
  }

  async fetch(request: Request) {
    return await this.bridge.fetch(request);
  }

  async queue(batch: MessageBatch<unknown>) {
    const result = await this.bridge.queue(
      batch.queue,
      batch.messages.map((message) => ({
        id: message.id,
        timestamp: message.timestamp,
        attempts: message.attempts,
        body: message.body,
      })),
      batch.metadata,
    );
    if (result.ackAll) {
      batch.ackAll();
    }
    if (result.retryBatch.retry) {
      batch.retryAll({ delaySeconds: result.retryBatch.delaySeconds });
    }
    const messages = Object.groupBy(batch.messages, (message) => message.id);
    for (const id of result.explicitAcks) {
      messages[id]?.forEach((message) => message.ack());
    }
    for (const retryMessage of result.retryMessages) {
      messages[retryMessage.msgId]?.forEach((message) =>
        message.retry({ delaySeconds: retryMessage.delaySeconds }),
      );
    }
  }
}

export class RemoteBridge extends DurableObject {
  transport?: Transport;
  session?: RpcSession<Bridge>;
  remoteMain?: RpcStub<Bridge>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const [local] = this.ctx.getWebSockets("local");
    if (local) {
      this.makeSession(local);
    }
  }

  private makeSession(ws: WebSocket) {
    this.transport = new Transport(ws, this.ctx);
    this.session = new RpcSession<Bridge>(this.transport, {
      webSocketMessage: async (id: string, message: string | ArrayBuffer) => {
        console.log("[remote] websocket message", id, message);
        const [target] = this.ctx.getWebSockets(id);
        if (target) {
          target.send(message);
        }
      },
      webSocketClose: async (id: string, code: number, reason: string, wasClean: boolean) => {
        console.log("[remote] websocket close", id, code, reason, wasClean);
        const [target] = this.ctx.getWebSockets(id);
        if (target) {
          target.close(code, reason);
        }
      },
      webSocketError: async (id: string, error: unknown) => {
        console.log("[remote] websocket error", id, error);
      },
    } satisfies WebSocketBridge);
    this.remoteMain = this.session.getRemoteMain();
  }

  private destroySession() {
    this.remoteMain?.[Symbol.dispose]();
    this.remoteMain = undefined;
    this.session = undefined;
    this.transport = undefined;
  }

  async fetch(request: Request) {
    if (
      request.headers.get("upgrade") === "websocket" &&
      request.url.endsWith(REMOTE_WEBSOCKET_PATH)
    ) {
      const [server, client] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ["local"]);
      this.makeSession(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (!this.remoteMain) {
      return new Response("Bad Gateway", { status: 502 });
    }
    const result = await this.remoteMain.fetch(request);
    switch (result.kind) {
      case "response":
        return result.response;
      case "upgrade":
        const [server, client] = Object.values(new WebSocketPair());
        this.ctx.acceptWebSocket(server, ["remote", result.id]);
        return new Response(null, {
          status: result.status,
          headers: result.headers,
          webSocket: client,
        });
    }
  }

  async queue(
    name: string,
    messages: Array<ServiceBindingQueueMessage>,
    metadata?: MessageBatchMetadata,
  ) {
    return await this.remoteMain?.queue(name, messages, metadata);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tags = this.ctx.getTags(ws) as ["local"] | ["remote", string];
    if (tags[0] === "remote") {
      this.remoteMain?.webSocketMessage(tags[1], message);
    } else {
      this.transport?.push(message.toString());
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    const tags = this.ctx.getTags(ws) as ["local"] | ["remote", string];
    if (tags[0] === "remote") {
      this.remoteMain?.webSocketClose(tags[1], code, reason, wasClean);
    } else {
      this.destroySession();
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const tags = this.ctx.getTags(ws) as ["local"] | ["remote", string];
    if (tags[0] === "remote") {
      this.remoteMain?.webSocketError(tags[1], error);
    }
  }
}

class Transport implements RpcTransport {
  private pulls: Array<PromiseWithResolvers<string>> = [];
  private pushes: Array<string> = [];

  constructor(
    private readonly ws: WebSocket,
    private readonly ctx: DurableObjectState,
  ) {}

  push(message: string) {
    const pull = this.pulls.shift();
    if (pull) {
      pull.resolve(message);
    } else {
      this.pushes.push(message);
    }
  }

  send(message: string): Promise<void> {
    this.ws.send(message);
    return Promise.resolve();
  }

  async receive(): Promise<string> {
    const push = this.pushes.shift();
    if (push) {
      return push;
    } else {
      const promise = Promise.withResolvers<string>();
      this.ctx.waitUntil(promise.promise);
      this.pulls.push(promise);
      return promise.promise;
    }
  }

  abort(reason: any): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1006, reason.message);
    }
    while (this.pulls.length > 0) {
      this.pulls.shift()?.reject(reason);
    }
  }
}
