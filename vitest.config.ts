import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['apps/**/src/__tests__/**/*.test.ts'],
    exclude: [
      '**/node_modules/**', 
      '**/dist/**', 
      '**/.next/**',
      '**/packages/**'
    ],
    timeout: 30000,
    reporters: ['verbose'],
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
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './apps/intention-engine/src'),
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
