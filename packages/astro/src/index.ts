import { make, type AstroFrameworkOptions } from "./Astro.ts";

export {
  make,
  makeAstroInlineConfig,
  type AstroConfigInputs,
  type AstroFrameworkOptions,
} from "./Astro.ts";
export {
  distilledCloudflare,
  IMAGE_PASSTHROUGH_ENDPOINT,
  makeIntegrationPluginOptions,
  NODE_ENVIRONMENTS,
  SERVER_ENTRYPOINT,
  type DistilledCloudflareOptions,
} from "./integration.ts";

/**
 * The e2e-harness framework factory contract: default-export a
 * `(options) => Layer<Framework>` factory that reads the cloudflare worker
 * configuration from `options.vite`.
 */
const framework = (options?: AstroFrameworkOptions) => make(options);

export default framework;
