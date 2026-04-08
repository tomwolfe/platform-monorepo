import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    env: {
      NODE_ENV: "test",
    },
    include: [
      "apps/**/src/__tests__/**/*.test.ts",
      "apps/**/src/**/__tests__/**/*.test.ts",
      "apps/**/src/**/__tests__/**/*.test.tsx",
      "packages/**/src/**/__tests__/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/packages/**/drizzle/**",
      "**/packages/shared/src/accessibility.tsx",
    ],
    timeout: 30000,
    reporters: ["verbose"],
    setupFiles: [
      "./apps/open-delivery/src/test/setup.ts",
      "./apps/table-stack/src/test/vitest-setup.ts",
      "./apps/intention-engine/src/test/vitest-setup.ts",
    ],
    // Use jsdom for React component tests
    environmentMatchGlobs: [
      ["**/*.test.tsx", "jsdom"],
      ["**/open-delivery/**", "jsdom"],
      ["**", "node"],
    ],
    server: {
      deps: {
        inline: [
          "@repo/shared",
          "@repo/mcp-protocol",
          "@repo/database",
          "@repo/auth",
          "@repo/typescript-config",
        ],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["apps/**/src/**/*.{ts,tsx}", "packages/**/src/**/*.{ts,tsx}"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/test/**",
        "**/mocks/**",
        "**/node_modules/**",
        "**/dist/**",
        "**/.next/**",
        "**/packages/**/drizzle/**",
      ],
      // Coverage thresholds - Phase 1.1: Testing Infrastructure
      // Elevated to 90% for enterprise-grade reliability (Phase 5)
      thresholds: {
        global: {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        // Per-file thresholds for critical modules
        "./packages/shared/src/**/*.ts": {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
      },
      // Generate coverage for all files, not just tested ones
      all: true,
      // Skip files that are pure type definitions
      skipFull: false,
    },
  },
  resolve: {
    alias: {
      // App-specific aliases - order matters! More specific patterns first
      // TableStack app aliases
      "@tablestack": path.resolve(__dirname, "./apps/table-stack/src"),
      // IntentionEngine app (must come before open-delivery aliases)
      "@": path.resolve(__dirname, "./apps/intention-engine/src"),
      // OpenDelivery app aliases (these won't override @ since @ comes first)
      "@open-delivery/components": path.resolve(
        __dirname,
        "./apps/open-delivery/src/components",
      ),
      "@open-delivery/lib": path.resolve(
        __dirname,
        "./apps/open-delivery/src/lib",
      ),
      "@open-delivery/test": path.resolve(
        __dirname,
        "./apps/open-delivery/src/test",
      ),
      // Shared packages
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
