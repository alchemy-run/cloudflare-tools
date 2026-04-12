import type { RpcTarget } from "capnweb";

export interface SerializedRequest {
  url: string;
  method: string;
  headers: Record<string, string | Array<string>>;
  body: string | null;
}

export interface SerializedResponse {
  status: number;
  headers: Record<string, string | Array<string>>;
  body: string | null;
}

export interface Manager extends RpcTarget {
  fetch(request: SerializedRequest): Promise<SerializedResponse>;
}

export function serializeHeaders(headers: Headers): Record<string, string | Array<string>> {
  const result: Record<string, string | Array<string>> = {};
  headers.forEach((value, key) => {
    if (key in result) {
      if (!Array.isArray(result[key])) {
        result[key] = [result[key]];
      }
      result[key].push(value);
    } else {
      result[key] = value;
    }
  });
  console.log("[serializeHeaders] result", result);
  return result;
}

export function deserializeHeaders(headers: Record<string, string | Array<string>>): Headers {
  const result = new Headers();
  console.log("[deserializeHeaders] headers", headers);
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const v of value) {
        result.append(key, v);
      }
    } else {
      result.set(key, value);
    }
  }
  return result;
}

export async function serializeRequest(request: Request): Promise<SerializedRequest> {
  return {
    url: request.url,
    method: request.method,
    headers: serializeHeaders(request.headers),
    body: request.body ? await request.text() : null,
  };
}

export function deserializeRequest(request: SerializedRequest): Request {
  return new Request(request.url, {
    method: request.method,
    headers: deserializeHeaders(request.headers),
    body: request.body,
  });
}

export async function serializeResponse(response: Response): Promise<SerializedResponse> {
  return {
    status: response.status,
    headers: serializeHeaders(response.headers),
    body: response.body ? await response.text() : null,
  };
}

export function deserializeResponse(response: SerializedResponse): Response {
  return new Response(response.body, {
    status: response.status,
    headers: deserializeHeaders(response.headers),
  });
}
