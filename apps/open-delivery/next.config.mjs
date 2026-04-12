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
    "@modelcontextprotocol/sdk",
    "@t3-oss/env-nextjs",
  ],
  webpack: (config, { isServer, dev }) => {
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push({
        "node:crypto": "commonjs node:crypto",
      });
      config.externals.push("wagmi");
      config.externals.push("viem");
      config.externals.push("zod");
      config.externals.push("abitype");
      config.externals.push("ox");
      config.externals.push("ws");
      config.externals.push("isows");
      config.externals.push("eventemitter3");
      config.externals.push("@noble/curves");
      config.externals.push("@noble/hashes");
      config.externals.push("@scure/bip32");
      config.externals.push("@scure/bip39");
      config.externals.push("webauthn-p256");
      config.externals.push("@modelcontextprotocol/sdk");
      config.externals.push("@t3-oss/env-nextjs");
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
  // Prevent webpack from bundling server components
  // This disables server-side route data collection which triggers the VyI error
  experimental: {
    serverMinification: false,
  },
  serverExternalPackages: [
    "@repo/shared",
    "@opentelemetry/sdk-node",
    "@opentelemetry/instrumentation",
    "@sentry/node",
    "async_hooks",
    "node:crypto",
    "worker_threads",
    "fs",
    "path",
    "crypto",
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
    "@modelcontextprotocol/sdk",
    "@t3-oss/env-nextjs",
  ],
};

export default nextConfig;
