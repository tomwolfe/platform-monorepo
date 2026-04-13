/** @type {import('next').NextConfig} */

// Import env validation FIRST - this will fail the build if required env vars are missing
import "./src/env.ts";

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const withBundleAnalyzer = require("@next/bundle-analyzer")({
  enabled: process.env.ANALYZE === "true",
});

import { createBaseNextConfig } from '@repo/typescript-config/next-base.mjs';

const baseConfig = createBaseNextConfig({
  // Force all routes to be dynamic in Next.js 15
  // Each route with dependencies that can't be serialized needs this
  // Keep ui-theme transpiled so it gets bundled
  transpilePackages: ["@repo/ui-theme", "@repo/mcp-protocol", "@repo/shared"],
});

export default withBundleAnalyzer(baseConfig);
