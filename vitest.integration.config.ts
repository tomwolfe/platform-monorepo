import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Integration Test Configuration
 *
 * Uses @testcontainers/postgres and @testcontainers/redis to spin up
 * real database instances for integration testing without mocks.
 *
 * Run with: pnpm test:integration
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    env: {
      NODE_ENV: "test",
    },
    include: [
      "apps/**/src/__tests__/integration/**/*.test.ts",
      "packages/**/src/__tests__/integration/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/__tests__/unit/**",
      "**/__tests__/e2e/**",
    ],
    timeout: 120000, // 2 minutes for container startup
    reporters: ["verbose"],
    poolOptions: {
      threads: {
        singleThread: true, // Run integration tests sequentially to avoid container conflicts
      },
    },
    globalSetup: ["./test/integration/globalSetup.ts"],
  },
  resolve: {
    alias: {
      "@tablestack": path.resolve(__dirname, "./apps/table-stack/src"),
      "@": path.resolve(__dirname, "./apps/intention-engine/src"),
      "@open-delivery/components": path.resolve(
        __dirname,
        "./apps/open-delivery/src/components",
      ),
      "@open-delivery/lib": path.resolve(
        __dirname,
        "./apps/open-delivery/src/lib",
      ),
      "@repo/shared": path.resolve(__dirname, "./packages/shared/src"),
      "@repo/mcp-protocol": path.resolve(
        __dirname,
        "./packages/mcp-protocol/src",
      ),
      "@repo/database": path.resolve(__dirname, "./packages/database/src"),
      "@repo/auth": path.resolve(__dirname, "./packages/auth/src"),
    },
  },
  esbuild: {
    target: "node20",
  },
});
