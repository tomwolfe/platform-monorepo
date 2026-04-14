/** @type {import('next').NextConfig} */

// Import env validation FIRST - this will fail the build if required env vars are missing
import "./src/env.ts";

import { createBaseNextConfig } from '@repo/typescript-config/next-base.mjs';

const nextConfig = createBaseNextConfig({
  // Force all routes to be dynamic in Next.js 15
  // Each route with dependencies that can't be serialized needs this
  // Keep ui-theme transpiled so it gets bundled
  transpilePackages: ["@repo/ui-theme", "@repo/mcp-protocol", "@repo/shared"],
});

// Bundle analyzer should be enabled via: ANALYZE=true pnpm build
// Note: For full bundle analysis, wrap with withBundleAnalyzer in the app
// when needed. The base config intentionally avoids bundler to keep it lean.

export default nextConfig;
