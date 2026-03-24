/**
 * Plugin chain composition.
 *
 * Aggregates the individual unplugins into a configured plugin chain
 * based on a `BundleConfig`.
 *
 * @module
 */
export { createAdditionalModulesCollector } from "./additional-modules.js";
export { CLOUDFLARE_BUILTINS, cloudflareExternals } from "./cloudflare-externals.js";
export { computeDefines, shouldDefineNavigatorUserAgent } from "./defines.js";
export { createNodejsCompatPlugin, hasNodejsCompat, NodejsCompatEnv } from "./nodejs-compat.js";
