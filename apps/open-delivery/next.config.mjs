/** @type {import('next').NextConfig} */

// Import env validation FIRST - this will fail the build if required env vars are missing
import "./src/env.ts";

const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  transpilePackages: ["@repo/ui-theme", "@repo/mcp-protocol"],
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
      config.externals = config.externals || [];
      config.externals.push({
        "node:crypto": "commonjs node:crypto",
      });
      config.externals.push("wagmi");
      config.externals.push("viem");
    }
    config.resolve ||= {};
    config.resolve.fallback ||= {};
    config.resolve.fallback["pino-pretty"] = false;
    config.resolve.fallback["@react-native-async-storage/async-storage"] =
      false;
    config.resolve.fallback["prettier/plugins/html"] = false;
    config.resolve.fallback["prettier/standalone"] = false;
    config.resolve.fallback["prettier/plugins/markdown"] = false;
    config.resolve.fallback["prettier/plugins/estree"] = false;
    return config;
  },
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
