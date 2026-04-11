import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Integration Test Configuration
 *
 * Runs tests against real infrastructure (PostgreSQL, Redis) via
 * @testcontainers when available, or against mocked backends for CI.
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
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: true, // Run integration tests sequentially to avoid container conflicts
      },
    },
    // Graceful handling when testcontainers aren't available
    globalSetup: ["./test/integration/globalSetup.ts"],
    bail: 1, // Stop on first failure to avoid cascading container errors
    retry: 1, // Retry flaky tests once
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
