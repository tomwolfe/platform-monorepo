/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@repo/ui-theme", "@repo/mcp-protocol"],
  serverExternalPackages: ["@opentelemetry/sdk-node", "@opentelemetry/instrumentation", "ably"],
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
