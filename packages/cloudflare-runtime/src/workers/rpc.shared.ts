export interface RpcRequest {
  type: "request";
  id: string;
  data: {
    url: string;
    method: string;
    headers: Record<string, string | Array<string>>;
    body: string | null;
  };
}

export interface RpcAbort {
  type: "abort";
  id: string;
}

export interface RpcWebSocketMessage {
  type: "websocket.message";
  id: string;
  data: string;
}

export interface RpcWebSocketClose {
  type: "websocket.close";
  id: string;
  data: {
    code: number;
    reason: string;
  };
}

export interface RpcResponse {
  type: "response";
  id: string;
  data: {
    status: number;
    headers: Record<string, string | Array<string>>;
    body?: string | null;
  };
}

export interface RpcResponseChunk {
  type: "response.chunk";
  id: string;
  data: string;
}

export interface RpcResponseEnd {
  type: "response.end";
  id: string;
}

export interface RpcUpgradeWebSocket {
  type: "websocket.upgrade";
  id: string;
  data: {
    status: number;
    headers: Record<string, string | Array<string>>;
  };
}
