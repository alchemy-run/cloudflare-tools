export interface WebSocketBridge {
  message(id: string, message: string | ArrayBuffer): Promise<void>;
  close(id: string, code: number, reason: string, wasClean: boolean): Promise<void>;
  error(id: string, error: unknown): Promise<void>;
}

export interface Bridge {
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
    | {
        kind: "error";
        error: Error;
      }
  >;
  queue(
    name: string,
    messages: Array<ServiceBindingQueueMessage>,
    metadata?: MessageBatchMetadata,
  ): Promise<FetcherQueueResult>;
  websocket: WebSocketBridge;
}
