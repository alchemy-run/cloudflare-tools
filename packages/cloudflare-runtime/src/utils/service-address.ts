import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

export class ServiceAddress extends Schema.Class<ServiceAddress>("ServiceAddress")({
  host: Schema.String,
  port: Schema.Int,
}) {
  toString() {
    return `${this.host}:${this.port}`;
  }
}

export const ServerAddressFromNode = Schema.Struct({
  address: Schema.String,
  port: Schema.Int,
}).pipe(
  Schema.decodeTo(ServiceAddress, {
    encode: SchemaGetter.transform(({ host, port }) => ({
      address: host,
      port,
    })),
    decode: SchemaGetter.transform(({ address, port }) => ({
      host: address,
      port,
    })),
  }),
);

export class ServerError extends Schema.TaggedErrorClass<ServerError>()("ServerError", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}
