export interface CloudflarePluginOptions {
  /**
   * The main entry point to use.
   * Defaults to the one from your Rolldown configuration.
   * @default undefined
   */
  main?: string;
  /**
   * The compatibility date to use. This is optional, but should be defined to avoid unexpected behavior.
   * @default undefined
   */
  compatibilityDate?: string;
  /**
   * The compatibility flags to enable.
   * @default []
   * @example
   * ```ts
   * cloudflare({ compatibilityDate: "2026-04-01", compatibilityFlags: ["nodejs_compat"] });
   * ```
   */
  compatibilityFlags?: Array<string>;
  /**
   * The exports to include in the bundle.
   * By default, all exports are included. However, if you only want to include certain exports, you can use this option.
   * @example
   * ```ts
   * cloudflare({ exports: ["default"] });
   * ```
   */
  exports?: Array<string>;
}
