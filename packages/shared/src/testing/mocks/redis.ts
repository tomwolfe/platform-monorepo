/**
 * Mock Redis Client Factory
 *
 * Shared factory for creating mock Redis clients for unit testing.
 * Replaces duplicated inline Redis mocks across apps.
 *
 * Usage:
 * ```typescript
 * import { createMockRedisClient } from '@repo/shared/testing/mocks/redis';
 *
 * const mockRedis = createMockRedisClient({
 *   initialData: { 'key:1': 'value1', 'key:2': 'value2' },
 * });
 *
 * // Use in tests
 * await mockRedis.get('key:1'); // Returns 'value1'
 * await mockRedis.set('key:3', 'value3');
 * ```
 */

export interface MockRedisOptions {
  /** Initial key-value pairs to populate */
  initialData?: Record<string, string>;
  /** Simulate latency in milliseconds */
  latency?: number;
  /** Simulate errors on specific operations */
  errorOn?: Array<
    "get" | "set" | "del" | "exists" | "keys" | "setex" | "incr" | "decr"
  >;
}

export interface MockRedisClient {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  setex: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  keys: ReturnType<typeof vi.fn>;
  incr: ReturnType<typeof vi.fn>;
  decr: ReturnType<typeof vi.fn>;
  sadd: ReturnType<typeof vi.fn>;
  smembers: ReturnType<typeof vi.fn>;
  srem: ReturnType<typeof vi.fn>;
  /** Clear all data and call history */
  reset: () => void;
  /** Get current store state (for assertions) */
  getStore: () => Record<string, string>;
}

/**
 * Create a mock Redis client with in-memory storage
 *
 * @param options - Configuration options
 * @returns Mock Redis client with vi.fn() methods
 */
export function createMockRedisClient(
  options: MockRedisOptions = {},
): MockRedisClient {
  const { initialData = {}, latency = 0, errorOn = [] } = options;
  const store: Record<string, string> = { ...initialData };
  const ttls: Record<string, number> = {};

  const simulateLatency = () =>
    latency > 0
      ? new Promise((resolve) => setTimeout(resolve, latency))
      : Promise.resolve();

  const shouldError = (op: string) =>
    errorOn.includes(op as MockRedisOptions["errorOn"][number]);

  const mockGet = vi.fn().mockImplementation(async (key: string) => {
    if (shouldError("get")) throw new Error(`Redis GET error on ${key}`);
    await simulateLatency();

    // Check TTL
    if (ttls[key] && Date.now() > ttls[key]) {
      delete store[key];
      delete ttls[key];
      return null;
    }

    return store[key] || null;
  });

  const mockSet = vi
    .fn()
    .mockImplementation(async (key: string, value: string) => {
      if (shouldError("set")) throw new Error(`Redis SET error on ${key}`);
      await simulateLatency();
      store[key] = value;
      return "OK";
    });

  const mockSetex = vi
    .fn()
    .mockImplementation(async (key: string, ttl: number, value: string) => {
      if (shouldError("setex")) throw new Error(`Redis SETEX error on ${key}`);
      await simulateLatency();
      store[key] = value;
      ttls[key] = Date.now() + ttl * 1000;
      return "OK";
    });

  const mockDel = vi.fn().mockImplementation(async (key: string) => {
    if (shouldError("del")) throw new Error(`Redis DEL error on ${key}`);
    await simulateLatency();
    const existed = key in store;
    delete store[key];
    delete ttls[key];
    return existed ? 1 : 0;
  });

  const mockExists = vi.fn().mockImplementation(async (key: string) => {
    if (shouldError("exists")) throw new Error(`Redis EXISTS error on ${key}`);
    await simulateLatency();
    return key in store && (!ttls[key] || Date.now() <= ttls[key]) ? 1 : 0;
  });

  const mockKeys = vi.fn().mockImplementation(async (pattern: string) => {
    if (shouldError("keys")) throw new Error(`Redis KEYS error`);
    await simulateLatency();

    const regex = new RegExp(
      `^${pattern.replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
    );
    return Object.keys(store).filter((key) => regex.test(key));
  });

  const mockIncr = vi.fn().mockImplementation(async (key: string) => {
    if (shouldError("incr")) throw new Error(`Redis INCR error on ${key}`);
    await simulateLatency();
    const currentValue = parseInt(store[key] || "0", 10);
    const newValue = currentValue + 1;
    store[key] = String(newValue);
    return newValue;
  });

  const mockDecr = vi.fn().mockImplementation(async (key: string) => {
    if (shouldError("decr")) throw new Error(`Redis DECR error on ${key}`);
    await simulateLatency();
    const currentValue = parseInt(store[key] || "0", 10);
    const newValue = currentValue - 1;
    store[key] = String(newValue);
    return newValue;
  });

  const mockSadd = vi
    .fn()
    .mockImplementation(async (key: string, value: string) => {
      await simulateLatency();
      const existing = store[key] ? JSON.parse(store[key]) : [];
      if (!existing.includes(value)) {
        existing.push(value);
        store[key] = JSON.stringify(existing);
      }
      return 1;
    });

  const mockSmembers = vi.fn().mockImplementation(async (key: string) => {
    await simulateLatency();
    return store[key] ? JSON.parse(store[key]) : [];
  });

  const mockSrem = vi
    .fn()
    .mockImplementation(async (key: string, value: string) => {
      await simulateLatency();
      const existing = store[key] ? JSON.parse(store[key]) : [];
      const index = existing.indexOf(value);
      if (index > -1) {
        existing.splice(index, 1);
        store[key] = JSON.stringify(existing);
        return 1;
      }
      return 0;
    });

  const reset = () => {
    Object.keys(store).forEach((key) => delete store[key]);
    Object.keys(ttls).forEach((key) => delete ttls[key]);
    mockGet.mockClear();
    mockSet.mockClear();
    mockSetex.mockClear();
    mockDel.mockClear();
    mockExists.mockClear();
    mockKeys.mockClear();
    mockIncr.mockClear();
    mockDecr.mockClear();
    mockSadd.mockClear();
    mockSmembers.mockClear();
    mockSrem.mockClear();
  };

  const getStore = () => ({ ...store });

  return {
    get: mockGet,
    set: mockSet,
    setex: mockSetex,
    del: mockDel,
    exists: mockExists,
    keys: mockKeys,
    incr: mockIncr,
    decr: mockDecr,
    sadd: mockSadd,
    smembers: mockSmembers,
    srem: mockSrem,
    reset,
    getStore,
  };
}

/**
 * Create a mock getRedisClient factory function
 *
 * Use this to mock the @repo/shared redis getter in tests:
 * ```typescript
 * vi.mock("@repo/shared", async (importOriginal) => {
 *   const actual = await importOriginal();
 *   return {
 *     ...actual,
 *     getRedisClient: createMockGetRedisClientFactory(),
 *   };
 * });
 * ```
 */
export function createMockGetRedisClientFactory(
  options?: MockRedisOptions,
): ReturnType<typeof vi.fn> {
  const mockClient = createMockRedisClient(options);
  return vi.fn().mockReturnValue(mockClient);
}
