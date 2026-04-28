export interface RemoteProxyConfig {
  url: string;
  headers: Record<"cf-workers-preview-token" | (string & {}), string>;
}
