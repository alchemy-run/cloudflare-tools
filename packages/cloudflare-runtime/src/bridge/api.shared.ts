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
  queue(
    name: string,
    messages: Array<ServiceBindingQueueMessage>,
    metadata?: MessageBatchMetadata,
  ): Promise<FetcherQueueResult>;
}
