/**
 * Vitest Setup File for IntentionEngine
 *
 * Global mocks for infrastructure dependencies.
 */

import { vi } from "vitest";

// Mock @repo/shared/llm-cache to avoid Redis import issues in tests
vi.mock("@repo/shared/llm-cache", () => ({
  getLlmCache: vi.fn(() => undefined),
  cacheLlmResponse: vi.fn(),
  generateLlmCacheKey: vi.fn(() => "mock-cache-key"),
  invalidateLlmCache: vi.fn(),
}));

// Mock @repo/shared/redis to provide a mock client
vi.mock("@repo/shared/redis", async () => {
  const actual = await vi.importActual("@repo/shared/redis");
  return {
    ...(actual as any),
    getRedisClient: vi.fn(() => ({
      get: vi.fn(() => Promise.resolve(null)),
      set: vi.fn(() => Promise.resolve("OK")),
      del: vi.fn(() => Promise.resolve(0)),
    })),
    ServiceNamespace: {
      IE: "ie",
      OD: "od",
      TS: "ts",
      SHARED: "shared",
    },
    getNamespacePrefix: vi.fn((ns: string) => ns),
  };
});
