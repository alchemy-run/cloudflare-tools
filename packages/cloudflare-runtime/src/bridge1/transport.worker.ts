import type { RpcTransport } from "capnweb";

export class DurableObjectTransport implements RpcTransport {
  private receiveQueue: Array<PromiseWithResolvers<string>> = [];

  constructor(private readonly ws: WebSocket) {}

  webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): void {
    const [next] = this.receiveQueue;
    if (next) {
      next.resolve(message.toString());
    } else {
      const promise = Promise.withResolvers<string>();
      this.receiveQueue.push(promise);
      promise.resolve(message.toString());
    }
  }

  async send(message: string): Promise<void> {
    this.ws.send(message);
  }

  receive(): Promise<string> {
    const [next] = this.receiveQueue;
    if (next) {
      return next.promise;
    } else {
      const promise = Promise.withResolvers<string>();
      this.receiveQueue.push(promise);
      return promise.promise;
    }
  }

  abort(reason: any): void {
    this.receiveQueue.forEach(({ reject }) => reject(reason));
    this.receiveQueue.length = 0;
  }
}

// interface DeferredPromise<T> extends PromiseWithResolvers<T> {
//   status: "pending" | "resolved" | "rejected";
// }

// function createDeferredPromise<T>(): DeferredPromise<T> {
//   const { resolve, reject, promise } = Promise.withResolvers<T>();
//   return {
//     status: "pending",
//     resolve(value) {
//       resolve(value);
//       this.status = "resolved";
//     },
//     reject(reason) {
//       reject(reason);
//       this.status = "rejected";
//     },
//     promise,
//   };
// }
