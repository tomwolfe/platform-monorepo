import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
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
      '**/packages/**/drizzle/**'
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
      '@': path.resolve(__dirname, './apps/intention-engine/src'),
      '@repo/shared': path.resolve(__dirname, './packages/shared/src'),
      '@repo/mcp-protocol': path.resolve(__dirname, './packages/mcp-protocol/src'),
      '@repo/database': path.resolve(__dirname, './packages/database/src'),
      '@repo/auth': path.resolve(__dirname, './packages/auth/src'),
      '@/components': path.resolve(__dirname, './apps/open-delivery/src/components'),
      '@/lib': path.resolve(__dirname, './apps/open-delivery/src/lib'),
      '@/test': path.resolve(__dirname, './apps/open-delivery/src/test'),
    },
  },
  esbuild: {
    target: 'node20',
  },
});
