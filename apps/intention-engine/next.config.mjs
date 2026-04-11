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
  output: "standalone",
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
        "node:crypto": "commonjs node:crypto",
      });
    }
    return config;
  },
  // Optimize bundle: skip importing heavy packages at module load time
  experimental: {
    optimizePackageImports: ["ai", "@ai-sdk/openai", "ably", "zod-to-json-schema"],
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default withBundleAnalyzer(nextConfig);
