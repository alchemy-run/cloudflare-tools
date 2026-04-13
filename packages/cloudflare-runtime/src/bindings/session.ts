import { bundle } from "#/utils/bundle";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Access from "./access";
import type { RemoteProxyConfig } from "./workers/config.shared";

export class SessionError extends Data.TaggedError("SessionError")<{
  message: string;
  cause?: unknown;
}> {}

export interface SessionOptions {
  scriptName: string;
  accountId: string;
  bindings: Array<SessionOptions.Binding>;
  host?: string;
  zoneId?: string;
  routes?: Array<SessionOptions.Route>;
}

export declare namespace SessionOptions {
  type Metadata = NonNullable<NonNullable<workers.CreateScriptEdgePreviewRequest["metadata"]>>;
  export type Binding = NonNullable<NonNullable<Metadata["bindings"]>>[number];
  export type Route = SimpleRoute | ZoneIdRoute | ZoneNameRoute | CustomDomainRoute;
  export type SimpleRoute = string;
  export interface ZoneIdRoute {
    pattern: string;
    zone_id: string;
    custom_domain?: boolean;
  }
  export interface ZoneNameRoute {
    pattern: string;
    zone_name: string;
    custom_domain?: boolean;
  }
  export interface CustomDomainRoute {
    pattern: string;
    custom_domain: boolean;
  }
}

export class SessionProvider extends Context.Service<
  SessionProvider,
  {
    readonly create: (options: SessionOptions) => Effect.Effect<RemoteProxyConfig, SessionError>;
  }
>()("SessionProvider") {}

export const SessionProviderLive = Layer.effect(
  SessionProvider,
  Effect.gen(function* () {
    const access = yield* Access.Access;
    const http = yield* HttpClient.HttpClient;
    const createSubdomainEdgePreviewSession = yield* workers.createSubdomainEdgePreviewSession;
    const createZoneEdgePreviewSession = yield* workers.createZoneEdgePreviewSession;
    const getSubdomain = yield* workers.getSubdomain;
    const createScriptEdgePreview = yield* workers.createScriptEdgePreview;

    const createPreviewUploadToken = Effect.fn(function* (options: SessionOptions) {
      const { token, exchangeUrl } = yield* options.zoneId
        ? createZoneEdgePreviewSession({
            zoneId: options.zoneId,
          })
        : createSubdomainEdgePreviewSession({
            accountId: options.accountId,
          });
      if (!exchangeUrl) {
        return token;
      }
      const switchedExchangeUrl = switchHost(exchangeUrl, options.host, !!options.zoneId);
      const headers = yield* access.getAccessHeaders(switchedExchangeUrl.hostname);
      const json = yield* http.get(switchedExchangeUrl, { headers }).pipe(
        Effect.flatMap((response) => response.json),
        Effect.timeout(30_000),
        Effect.catch(() => Effect.succeed(null)),
      );
      if (
        typeof json === "object" &&
        json !== null &&
        "token" in json &&
        typeof json.token === "string"
      ) {
        return json.token;
      }
      return token;
    });

    const uploadPreviewScript = Effect.fn(function* (
      options: SessionOptions,
      cfPreviewUploadConfigToken: string,
    ) {
      const script = yield* bundle("src/bindings/workers/remote.worker.ts").pipe(
        Effect.map(
          (output) =>
            new File([output[0].code], "worker.js", {
              type: "application/javascript+module",
            }),
        ),
      );
      return yield* createScriptEdgePreview({
        accountId: options.accountId,
        scriptName: options.scriptName,
        cfPreviewUploadConfigToken,
        wranglerSessionConfig: options.routes?.length
          ? {
              routes: options.routes.map((route) => {
                if (typeof route === "string") {
                  return route;
                }
                if (route.custom_domain) {
                  return `${route.pattern}/*`;
                }
                return route.pattern;
              }),
              minimalMode: true,
            }
          : { workersDev: true, minimalMode: true },
        metadata: {
          compatibilityDate: "2025-04-28",
          bindings: options.bindings,
          mainModule: script.name,
        },
        files: [script],
      }).pipe(Effect.timeout(30_000));
    });

    const getWorkerHost = Effect.fn(function* (options: SessionOptions) {
      if (options.host) {
        return options.host;
      }
      const { subdomain } = yield* getSubdomain({ accountId: options.accountId });
      return `${options.scriptName}.${subdomain}.workers.dev`;
    });

    return SessionProvider.of({
      create: Effect.fn(
        function* (options) {
          const [previewToken, { url, headers }] = yield* Effect.all(
            [
              createPreviewUploadToken(options).pipe(
                Effect.flatMap((cfPreviewUploadConfigToken) =>
                  uploadPreviewScript(options, cfPreviewUploadConfigToken),
                ),
                Effect.map((result) => result.previewToken),
              ),
              getWorkerHost(options).pipe(
                Effect.flatMap(
                  Effect.fn(function* (host) {
                    const headers = yield* access.getAccessHeaders(host);
                    return { url: `https://${host}`, headers };
                  }),
                ),
              ),
            ],
            { concurrency: "unbounded" },
          );
          return {
            url,
            headers: { ...headers, "cf-workers-preview-token": previewToken },
          };
        },
        Effect.mapError(
          (cause) => new SessionError({ message: "Failed to create session", cause }),
        ),
      ),
    });
  }),
);

function switchHost(originalUrl: string, host: string | undefined, hasZoneId: boolean): URL {
  const url = new URL(originalUrl);
  if (hasZoneId && host) {
    url.hostname = host;
  }
  return url;
}
