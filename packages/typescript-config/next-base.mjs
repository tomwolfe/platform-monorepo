/**
 * Shared Next.js Configuration Base
 *
 * Extracts common configuration patterns to prevent "config drift" as the monorepo grows.
 * All apps should import from this file and extend with app-specific overrides only.
 *
 * Usage in app's next.config.mjs:
 * ```mjs
 * import { createBaseNextConfig } from '@repo/typescript-config/next-base.mjs';
 *
 * const nextConfig = createBaseNextConfig({
 *   // App-specific overrides
 *   output: 'standalone',
 *   serverExternalPackages: ['my-special-package'],
 * });
 *
 * export default nextConfig;
 * ```
 *
 * @see Task T3: DRY the Build Layer
 */

/**
 * Common server external packages shared across all apps
 * These packages should not be bundled by Webpack and should use Node.js native modules
 */
export const COMMON_SERVER_EXTERNALS = [
  "@opentelemetry/sdk-node",
  "@opentelemetry/instrumentation",
  "@sentry/node",
  "async_hooks",
  "node:crypto",
  "worker_threads",
  "fs",
  "path",
  "crypto",
];

/**
 * Common Webpack fallbacks shared across all apps
 * These prevent build errors for packages that are optionally imported but not needed in production
 */
export const COMMON_WEBPACK_FALLBACKS = {
  "pino-pretty": false,
  "@react-native-async-storage/async-storage": false,
  "prettier/plugins/html": false,
  "prettier/standalone": false,
  "prettier/plugins/markdown": false,
  "prettier/plugins/estree": false,
};

/**
 * Common Web3 packages that should be externalized (not bundled)
 * These are heavy packages that should remain as Node.js modules
 */
export const WEB3_EXTERNALS = [
  "viem",
  "zod",
  "abitype",
  "@noble/curves",
  "@noble/hashes",
  "@scure/bip32",
  "@scure/bip39",
  "ox",
  "ws",
  "isows",
  "eventemitter3",
  "webauthn-p256",
];

/**
 * Common Web3 Webpack externals for server-side builds
 */
export const WEB3_WEBPACK_EXTERNALS = [
  "viem",
  "zod",
  "abitype",
  "ox",
  "ws",
  "isows",
  "eventemitter3",
  "@noble/curves",
  "@noble/hashes",
  "@scure/bip32",
  "@scure/bip39",
  "webauthn-p256",
];

/**
 * Base Next.js configuration
 * Creates a consistent config object with shared settings
 *
 * @param appConfig - App-specific configuration overrides
 * @param options - Build options
 * @param options.isWeb3App - Include Web3-specific externals (default: false)
 * @param options.additionalExternals - Additional server external packages
 * @param options.additionalWebpackFallbacks - Additional webpack fallbacks
 *
 * @returns Next.js config object ready for export
 *
 * @example
 * ```mjs
 * // apps/my-app/next.config.mjs
 * import { createBaseNextConfig } from '@repo/typescript-config/next-base.mjs';
 *
 * const nextConfig = createBaseNextConfig({
 *   output: 'standalone',
 *   serverExternalPackages: ['my-special-package'],
 * });
 *
 * export default nextConfig;
 * ```
 */
export function createBaseNextConfig(
  appConfig = {},
  options = {},
) {
  const {
    isWeb3App = false,
    additionalExternals = [],
    additionalWebpackFallbacks = {},
  } = options;

  // Merge server external packages
  const serverExternalPackages = [
    ...COMMON_SERVER_EXTERNALS,
    ...(isWeb3App ? WEB3_EXTERNALS : []),
    ...additionalExternals,
  ];

  // Merge webpack fallbacks
  const webpackFallbacks = {
    ...COMMON_WEBPACK_FALLBACKS,
    ...additionalWebpackFallbacks,
  };

  // Base Next.js config
  const baseConfig = {
    reactStrictMode: true,
    transpilePackages: ["@repo/ui-theme", "@repo/mcp-protocol"],
    serverExternalPackages,
    webpack: (config, { isServer }) => {
      if (isServer) {
        config.externals = config.externals || [];
        config.externals.push({
          "node:crypto": "commonjs node:crypto",
        });

        // Add Web3 externals for Web3 apps
        if (isWeb3App) {
          WEB3_WEBPACK_EXTERNALS.forEach((pkg) => {
            if (!config.externals.includes(pkg)) {
              config.externals.push(pkg);
            }
          });
        }
      }

      // Apply common fallbacks
      config.resolve ||= {};
      config.resolve.fallback ||= {};
      Object.assign(config.resolve.fallback, webpackFallbacks);

      return config;
    },
    typescript: {
      ignoreBuildErrors: true,
    },
    ...appConfig,
  };

  // Note: Bundle analyzer should be applied by the app if needed:
  // import withBundleAnalyzer from '@next/bundle-analyzer';
  // export default withBundleAnalyzer({ enabled: process.env.ANALYZE === 'true' })(baseConfig);

  return baseConfig;
}
