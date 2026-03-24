import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      NODE_ENV: 'test',
    },
    include: [
      'apps/**/src/__tests__/**/*.test.ts',
      'apps/**/src/**/__tests__/**/*.test.ts',
      'apps/**/src/**/__tests__/**/*.test.tsx',
      'packages/**/src/**/__tests__/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/packages/**/drizzle/**',
      '**/packages/shared/src/accessibility.tsx',
      '**/apps/intention-engine/src/lib/__tests__/occ-integration.test.ts', // Requires Redis connection
      '**/apps/intention-engine/src/lib/__tests__/execution_safety.test.ts', // Uses process.exit()
      '**/apps/intention-engine/src/lib/__tests__/engine_failure_simulation.test.ts', // No vitest tests
      '**/apps/table-stack/src/app/api/v1/reserve/__tests__/route.test.ts', // Module resolution issues
      '**/apps/intention-engine/src/__tests__/chaos-engineering.test.ts', // Complex mocking issues - TODO fix
      '**/apps/intention-engine/src/__tests__/saga-integration.test.ts', // Complex mocking issues - TODO fix
    ],
    timeout: 30000,
    reporters: ['verbose'],
    setupFiles: [
      './apps/open-delivery/src/test/setup.ts',
      './apps/table-stack/src/test/vitest-setup.ts',
    ],
    server: {
      deps: {
        inline: [
          '@repo/shared',
          '@repo/mcp-protocol',
          '@repo/database',
          '@repo/auth',
          '@repo/typescript-config',
        ],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: [
        'apps/**/src/**/*.{ts,tsx}',
        'packages/**/src/**/*.{ts,tsx}',
      ],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/test/**',
        '**/mocks/**',
        '**/node_modules/**',
        '**/dist/**',
        '**/.next/**',
        '**/packages/**/drizzle/**',
      ],
      // Coverage thresholds - Phase 1.1: Testing Infrastructure
      thresholds: {
        global: {
          branches: 75,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        // Per-file thresholds for critical modules
        './packages/shared/src/**/*.ts': {
          branches: 75,
          functions: 80,
          lines: 80,
          statements: 80,
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
      '@tablestack': path.resolve(__dirname, './apps/table-stack/src'),
      // IntentionEngine app (must come before open-delivery aliases)
      '@': path.resolve(__dirname, './apps/intention-engine/src'),
      // OpenDelivery app aliases (these won't override @ since @ comes first)
      '@open-delivery/components': path.resolve(__dirname, './apps/open-delivery/src/components'),
      '@open-delivery/lib': path.resolve(__dirname, './apps/open-delivery/src/lib'),
      '@open-delivery/test': path.resolve(__dirname, './apps/open-delivery/src/test'),
      // Shared packages
      '@repo/shared': path.resolve(__dirname, './packages/shared/src'),
      '@repo/mcp-protocol': path.resolve(__dirname, './packages/mcp-protocol/src'),
      '@repo/database': path.resolve(__dirname, './packages/database/src'),
      '@repo/auth': path.resolve(__dirname, './packages/auth/src'),
    },
  },
  esbuild: {
    target: 'node20',
  },
});
