/** @type {import('next').NextConfig} */

// Import env validation FIRST - this will fail the build if required env vars are missing
import "./src/env.js";

const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  transpilePackages: ["@repo/ui-theme", "@repo/mcp-protocol"],
  serverExternalPackages: [
    "@opentelemetry/sdk-node",
    "@opentelemetry/instrumentation",
    "ably",
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
        'node:crypto': 'commonjs node:crypto'
      });
    }
    return config;
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
