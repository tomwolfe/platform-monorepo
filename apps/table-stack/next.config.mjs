/** @type {import('next').NextConfig} */

// Import env validation FIRST - this will fail the build if required env vars are missing
import "./src/env.ts";

import { createBaseNextConfig } from '@repo/typescript-config/next-base.mjs';

const nextConfig = createBaseNextConfig({
  output: "standalone",
});

export default nextConfig;
