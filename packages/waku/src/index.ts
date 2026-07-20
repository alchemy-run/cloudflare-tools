import { make, type WakuFrameworkOptions } from "./Waku.ts";

export {
  make,
  makeWakuConfigInput,
  makeWakuPluginOptions,
  WAKU_SERVER_ENTRY_MODULE,
  WAKU_SERVER_ENTRY_PATH,
  type WakuConfigInputs,
  type WakuFrameworkOptions,
} from "./Waku.ts";

/**
 * The e2e-harness framework factory contract: default-export a
 * `(options) => Layer<Framework>` factory that reads the cloudflare worker
 * configuration from `options.vite`.
 */
const framework = (options?: WakuFrameworkOptions) => make(options);

export default framework;
