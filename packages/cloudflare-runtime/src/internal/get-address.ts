import * as Effect from "effect/Effect";
import type * as NodeHttp from "node:http";
import { SystemError } from "../RuntimeError.shared.ts";

export const getAddress = (server: NodeHttp.Server): Effect.Effect<string, SystemError> => {
  const address = server.address();
  if (address === null) {
    return Effect.fail(
      new SystemError({
        subtag: "ServerAddressNotAvailable",
        message: "Server address is not available.",
        detail: { server },
      }),
    );
  }
  if (typeof address === "string") {
    return Effect.succeed(address);
  }
  return Effect.succeed(
    `${address.address === "::" ? "127.0.0.1" : address.address}:${address.port}`,
  );
};
