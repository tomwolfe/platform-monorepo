/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@repo/ui-theme", "@repo/mcp-protocol"],
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
