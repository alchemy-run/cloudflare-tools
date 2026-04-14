export const LOCAL_CONFIGURE_PATH = "/__distilled/bridge/configure";
export const REMOTE_WEBSOCKET_PATH = "/__distilled/bridge/websocket";

export interface WebSocketBridge {
  webSocketMessage(id: string, message: string | ArrayBuffer): Promise<void>;
  webSocketClose(id: string, code: number, reason: string, wasClean: boolean): Promise<void>;
  webSocketError(id: string, error: unknown): Promise<void>;
}

export interface Bridge extends WebSocketBridge {
  fetch(request: Request): Promise<
    | {
        kind: "response";
        response: Response;
      }
    | {
        kind: "upgrade";
        status: number;
        headers: Headers;
        id: string;
      }
  >;
  dispatchQueue(
    name: string,
    messages: Array<ServiceBindingQueueMessage>,
    metadata?: MessageBatchMetadata,
  ): Promise<FetcherQueueResult>;
}
