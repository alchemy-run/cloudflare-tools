import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as RemoteWorker from "worker:./workers/remote.worker.ts";
import type { OutboundConfig, SessionOptions } from "./RemoteConfig.ts";

export class SessionError extends Data.TaggedError("SessionError")<{
  message: string;
  cause?: unknown;
}> {}

export class RemoteSession extends Context.Service<
  RemoteSession,
  {
    readonly create: (options: SessionOptions) => Effect.Effect<OutboundConfig, SessionError>;
  }
>()("RemoteSession") {}

export const make = Effect.fn(function* (accountId: string) {
  const http = yield* HttpClient.HttpClient;
  const createSubdomainEdgePreviewSession = yield* workers.createSubdomainEdgePreviewSession;
  const getSubdomain = yield* workers.getSubdomain;
  const createScriptEdgePreview = yield* workers.createScriptEdgePreview;

  const AccountSubdomain = yield* Effect.cached(getSubdomain({ accountId }));

  const createPreviewUploadToken = Effect.fn(function* () {
    const { token, exchangeUrl } = yield* createSubdomainEdgePreviewSession({
      accountId,
    });
    if (!exchangeUrl) {
      return token;
    }
    const json = yield* http.get(exchangeUrl).pipe(
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
    const files = RemoteWorker.modules.map(
      (module) =>
        new File([module.content], module.name, { type: "application/javascript+module" }),
    );
    return yield* createScriptEdgePreview({
      accountId,
      scriptName: options.name,
      cfPreviewUploadConfigToken,
      wranglerSessionConfig: { workersDev: true, minimalMode: true },
      metadata: {
        compatibilityDate: "2025-04-28",
        bindings: options.bindings,
        mainModule: files[0].name,
      },
      files,
    }).pipe(Effect.timeout(30_000));
  });

  return RemoteSession.of({
    create: Effect.fn(
      function* (options) {
        const [{ previewToken }, url] = yield* Effect.all(
          [
            createPreviewUploadToken().pipe(
              Effect.flatMap((cfPreviewUploadConfigToken) =>
                uploadPreviewScript(options, cfPreviewUploadConfigToken),
              ),
            ),
            AccountSubdomain.pipe(
              Effect.map(({ subdomain }) => `https://${options.name}.${subdomain}.workers.dev`),
            ),
          ],
          { concurrency: "unbounded" },
        );
        return {
          url,
          headers: { "cf-workers-preview-token": previewToken },
        };
      },
      Effect.mapError((cause) => new SessionError({ message: "Failed to create session", cause })),
    ),
  });
});

export const layer = (accountId: string) => Layer.effect(RemoteSession, make(accountId));
