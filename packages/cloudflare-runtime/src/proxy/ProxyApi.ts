export const LOCAL_CONFIGURE_PATH = "/__distilled/proxy/configure";
export const REMOTE_WEBSOCKET_PATH = "/__distilled/proxy/websocket";

export type ControllerMessage = ControllerMessage.Set | ControllerMessage.Unset;

export declare namespace ControllerMessage {
  type WorkerKind = "Local" | "Remote";

  interface Set {
    readonly _tag: `${WorkerKind}.Set`;
    readonly worker: string;
    readonly address: string;
  }

  interface Unset {
    readonly _tag: `${WorkerKind}.Unset`;
    readonly worker: string;
    readonly address: string;
  }
}

export interface WebSocketProxy {
  readonly webSocketMessage: (id: string, message: string | ArrayBuffer) => Promise<void>;
  readonly webSocketClose: (
    id: string,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => Promise<void>;
  readonly webSocketError: (id: string, error: unknown) => Promise<void>;
}

export interface WorkerProxy extends WebSocketProxy {
  readonly fetch: (request: Request) => Promise<WorkerProxy.FetchResult>;
}

export declare namespace WorkerProxy {
  interface FetchResponse {
    readonly _tag: "Response";
    readonly response: Response;
  }
  interface FetchUpgradeResponse {
    readonly _tag: "Upgrade";
    readonly status: number;
    readonly headers: Headers;
    readonly id: string;
  }
  type FetchResult = FetchResponse | FetchUpgradeResponse;
}
