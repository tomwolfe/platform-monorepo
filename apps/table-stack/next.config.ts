import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  transpilePackages: ["@repo/ui-theme", "@repo/mcp-protocol", "@repo/database"],
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
