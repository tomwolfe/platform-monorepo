/** @type {import('next').NextConfig} */

// Import env validation FIRST - this will fail the build if required env vars are missing
import "./src/env.ts";

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const withBundleAnalyzer = require("@next/bundle-analyzer")({
  enabled: process.env.ANALYZE === "true",
});

const nextConfig = {
  reactStrictMode: true,
  // Force all routes to be dynamic in Next.js 15
  // Each route with dependencies that can't be serialized needs this
  // Keep ui-theme transpiled so it gets bundled
  // Tell Next.js these are client-only packages
  transpilePackages: ["@repo/ui-theme", "@repo/mcp-protocol", "@repo/shared"],
  serverExternalPackages: [
    "@opentelemetry/sdk-node",
    "@opentelemetry/instrumentation",
    "@sentry/node",
    "async_hooks",
    "node:crypto",
    "worker_threads",
    "fs",
    "path",
    "crypto",
  ],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Mark node: built-in modules as external
      config.externals = config.externals || [];
      config.externals.push({
        "node:crypto": "commonjs node:crypto",
      });
    }
    // pino-pretty is an optional dev dependency of pino (for pretty-printing logs).
    // @walletconnect/logger imports it but it's not needed in production.
    config.resolve ||= {};
    config.resolve.fallback ||= {};
    config.resolve.fallback["pino-pretty"] = false;
    config.resolve.fallback["@react-native-async-storage/async-storage"] =
      false;
    config.resolve.fallback["prettier/plugins/html"] = false;
    config.resolve.fallback["prettier/standalone"] = false;
    config.resolve.fallback["prettier/plugins/markdown"] = false;
    config.resolve.fallback["prettier/plugins/estree"] = false;

    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push({
        "node:crypto": "commonjs node:crypto",
      });
    }
    return config;
  },
  // Optimize bundle: skip importing heavy packages at module load time
  // Disabled during build to prevent static generation issues
  experimental: {},
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default withBundleAnalyzer(nextConfig);
