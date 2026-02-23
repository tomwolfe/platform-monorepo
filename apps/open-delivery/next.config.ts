import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
  // Enable standalone output for Docker/CI deployments
  output: 'standalone',
  // Ensure all required assets are included
  experimental: {
    serverComponentsExternalPackages: ['ably'],
  },
};

export default nextConfig;
