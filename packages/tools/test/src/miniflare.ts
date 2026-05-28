import { Miniflare, type MiniflareOptions, type RequestInit, type Response } from "miniflare";
import type { RolldownOutput } from "rolldown";
import { miniflareModulesFromRolldownOutput } from "./miniflare-module";

export interface MiniflareInstance {
  url: URL;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  fetchText(path: string, init?: RequestInit): Promise<string>;
  fetchJson<T>(path: string, init?: RequestInit): Promise<T>;
  [Symbol.asyncDispose]: () => Promise<void>;
}

type Options = Extract<MiniflareOptions, { modules: Array<any> }>;

export async function createMiniflare(options: Options): Promise<MiniflareInstance> {
  const miniflare = new Miniflare(options);
  const url = await miniflare.ready;
  const fetch = (path: string, init?: RequestInit) =>
    miniflare.dispatchFetch(`http://localhost${path}`, init);
  return {
    url,
    fetch,
    fetchText: (path, init) => fetch(path, init).then((response) => response.text()),
    fetchJson: <T>(path: string, init?: RequestInit) =>
      fetch(path, init).then((response) => response.json() as Promise<T>),
    [Symbol.asyncDispose]: () => miniflare.dispose(),
  };
}

export async function createMiniflareFromRolldown(
  output: RolldownOutput,
  options: Partial<Options> = {},
): Promise<MiniflareInstance> {
  return createMiniflare({
    modules: miniflareModulesFromRolldownOutput(output.output),
    ...options,
  });
}
