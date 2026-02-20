import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  transpilePackages: ["@repo/ui-theme", "@repo/mcp-protocol"],
  serverExternalPackages: ["ably"],
  eslint: {
    ignoreDuringBuilds: true,
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [...(config.externals || []), 'async_hooks'];
    }
    return config;
  },
};

export default nextConfig;
