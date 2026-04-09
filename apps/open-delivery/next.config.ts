import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@repo/ui-theme", "@repo/mcp-protocol"],
  serverExternalPackages: ["ably", "async_hooks", "node:crypto"],
  eslint: {
    ignoreDuringBuilds: true,
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [
        ...(config.externals || []),
        "async_hooks",
        { "node:crypto": "commonjs node:crypto" },
      ];
    }
    return config;
  },
  // Enable standalone output for Docker/CI deployments
  output: "standalone",
};

export default nextConfig;
