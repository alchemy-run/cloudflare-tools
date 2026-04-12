export declare namespace Rpc {
  interface Request {
    type: "request";
    id: string;
    data: {
      url: string;
      method: string;
      headers: Record<string, string | Array<string>>;
      hasBody: boolean;
    };
  }

  interface RequestChunk {
    type: "request.chunk";
    id: string;
    data: string;
  }

  interface RequestEnd {
    type: "request.end";
    id: string;
  }

  type RemoteMessage = Request | RequestChunk | RequestEnd;

  interface Response {
    type: "response";
    id: string;
    data: {
      status: number;
      headers: Record<string, string | Array<string>>;
      hasBody: boolean;
      hasWebSocket: boolean;
    };
  }

  interface ResponseChunk {
    type: "response.chunk";
    id: string;
    data: string;
  }

  interface ResponseEnd {
    type: "response.end";
    id: string;
  }

  type LocalMessage =
    | Response
    | ResponseChunk
    | ResponseEnd
    | WebSocketMessage
    | WebSocketClose
    | WebSocketError;

  interface WebSocketMessage {
    type: "websocket.message";
    id: string;
    data: string;
  }

  interface WebSocketClose {
    type: "websocket.close";
    id: string;
    data: {
      code: number;
      reason: string;
    };
  }

  interface WebSocketError {
    type: "websocket.error";
    id: string;
    data: string;
  }
}
