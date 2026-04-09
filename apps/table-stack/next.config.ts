import type { NextConfig } from "next";
import withBundleAnalyzer from "@next/bundle-analyzer";

const bundleAnalyzer = withBundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const nextConfig: NextConfig = {
  transpilePackages: ["@repo/ui-theme", "@repo/mcp-protocol", "@repo/database"],
  serverExternalPackages: ["ably", "async_hooks", "node:crypto"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [
        ...(config.externals || []),
        { "node:crypto": "commonjs node:crypto" },
      ];
    }
    return config;
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Optimize large packages
  experimental: {
    optimizePackageImports: ["viem", "wagmi", "ably", "swagger-ui-react"],
  },
};

export default bundleAnalyzer(nextConfig);
