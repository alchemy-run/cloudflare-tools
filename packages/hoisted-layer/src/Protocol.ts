import * as Schema from "effect/Schema";

export const HOISTED_LAYER_ADDRESS_ENV = "DISTILLED_HOISTED_LAYER_ADDRESS";

export const HoistedLayerAddress = Schema.Struct({
  host: Schema.String,
  port: Schema.Number,
});

export type HoistedLayerAddress = typeof HoistedLayerAddress.Type;

const decodeAddress = Schema.decodeUnknownSync(HoistedLayerAddress);

export function encodeAddressEnv(address: HoistedLayerAddress): Record<string, string> {
  return {
    [HOISTED_LAYER_ADDRESS_ENV]: JSON.stringify(address),
  };
}

export function readAddressFromEnv(
  env: Record<string, string | undefined> = process.env,
): HoistedLayerAddress | undefined {
  const value = env[HOISTED_LAYER_ADDRESS_ENV];
  if (value === undefined) {
    return undefined;
  }
  return decodeAddress(JSON.parse(value));
}
