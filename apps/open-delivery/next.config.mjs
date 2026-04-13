/** @type {import('next').NextConfig} */

// Import env validation FIRST - this will fail the build if required env vars are missing
import "./src/env.ts";

import { createBaseNextConfig } from '@repo/typescript-config/next-base.mjs';

const nextConfig = createBaseNextConfig({
  output: "standalone",
  transpilePackages: ["@repo/ui-theme", "@repo/mcp-protocol"],
  serverExternalPackages: [
    "@modelcontextprotocol/sdk",
    "@t3-oss/env-nextjs",
  ],
  // Prevent webpack from bundling server components
  // This disables server-side route data collection which triggers the VyI error
  experimental: {
    serverMinification: false,
  },
}, {
  isWeb3App: true,
});

export default nextConfig;
