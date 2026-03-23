// ============================================================================
// SHARED TEST UTILITIES
// Phase 1.1: Testing Infrastructure
// ============================================================================
// 
// Standardized mocking and test utilities for isolated unit/integration tests.
// Use these utilities to avoid duplicating mock setup across test files.
//
// Usage:
//   import { createTestContainer, mockServiceProvider } from '@repo/shared/test-utils';
//
// ============================================================================

import { vi, beforeEach, afterEach, type MockedFunction } from 'vitest';

// ============================================================================
// TYPES
// ============================================================================

export interface TestContainer {
  redis: MockedRedis;
  db: MockedDatabase;
  ably: MockedAbly;
  qstash: MockedQStash;
  cleanup: () => Promise<void>;
}

export interface MockedRedis {
  get: MockedFunction<(key: string) => Promise<any>>;
  set: MockedFunction<(key: string, value: any) => Promise<number>>;
  del: MockedFunction<(key: string) => Promise<number>>;
  incr: MockedFunction<(key: string) => Promise<number>>;
  expire: MockedFunction<(key: string, seconds: number) => Promise<number>>;
  pipeline: MockedFunction<() => RedisPipeline>;
  hget: MockedFunction<(key: string, field: string) => Promise<any>>;
  hset: MockedFunction<(key: string, field: string, value: any) => Promise<number>>;
  hgetall: MockedFunction<(key: string) => Promise<Record<string, any>>>;
  hdel: MockedFunction<(key: string, field: string) => Promise<number>>;
  lpush: MockedFunction<(key: string, value: any) => Promise<number>>;
  rpop: MockedFunction<(key: string) => Promise<any>>;
  llen: MockedFunction<(key: string) => Promise<number>>;
  lrange: MockedFunction<(key: string, start: number, stop: number) => Promise<any[]>>;
  sadd: MockedFunction<(key: string, member: string) => Promise<number>>;
  sismember: MockedFunction<(key: string, member: string) => Promise<number>>;
  smembers: MockedFunction<(key: string) => Promise<string[]>>;
}

export interface RedisPipeline {
  get: MockedFunction<(key: string) => RedisPipeline>;
  set: MockedFunction<(key: string, value: any) => RedisPipeline>;
  incr: MockedFunction<(key: string) => RedisPipeline>;
  expire: MockedFunction<(key: string, seconds: number) => RedisPipeline>;
  exec: MockedFunction<() => Promise<any[]>>;
}

export interface MockedDatabase {
  select: MockedFunction<(table: any) => any>;
  insert: MockedFunction<(table: any) => any>;
  update: MockedFunction<(table: any) => any>;
  delete: MockedFunction<(table: any) => any>;
  transaction: MockedFunction<(fn: any) => Promise<any>>;
  $client: any;
}

export interface MockedAbly {
  channels: MockedAblyChannels;
  connect: MockedFunction<() => void>;
  disconnect: MockedFunction<() => void>;
  connection: {
    state: string;
    on: MockedFunction<(event: string, callback: any) => void>;
  };
}

export interface MockedAblyChannels {
  get: MockedFunction<(channelName: string) => MockedAblyChannel>;
}

export interface MockedAblyChannel {
  publish: MockedFunction<(name: string, data: any) => Promise<void>>;
  subscribe: MockedFunction<(event: string, callback: any) => void>;
  unsubscribe: MockedFunction<(event: string, callback: any) => void>;
}

export interface MockedQStash {
  publish: MockedFunction<(options: any) => Promise<any>>;
  publishJSON: MockedFunction<(options: any) => Promise<any>>;
  enqueue: MockedFunction<(options: any) => Promise<any>>;
}

// ============================================================================
// TEST CONTAINER FACTORY
// Creates a fully mocked test environment with Redis, DB, Ably, and QStash
// ============================================================================

export function createTestContainer(): TestContainer {
  const redis = createMockRedis();
  const db = createMockDatabase();
  const ably = createMockAbly();
  const qstash = createMockQStash();

  return {
    redis,
    db,
    ably,
    qstash,
    cleanup: async () => {
      // Clear all mocks
      vi.clearAllMocks();
    },
  };
}

// ============================================================================
// MOCK REDIS
// In-memory Redis mock with realistic behavior
// ============================================================================

const inMemoryStore = new Map<string, any>();
const inMemoryHashes = new Map<string, Map<string, any>>();
const inMemoryLists = new Map<string, any[]>();
const inMemorySets = new Map<string, Set<string>>();
const inMemoryExpiry = new Map<string, number>();

function createMockRedis(): MockedRedis {
  const mock: MockedRedis = {
    get: vi.fn(async (key: string) => {
      // Check expiry
      const expiry = inMemoryExpiry.get(key);
      if (expiry && Date.now() > expiry) {
        inMemoryStore.delete(key);
        inMemoryExpiry.delete(key);
        return null;
      }
      return inMemoryStore.get(key) ?? null;
    }),

    set: vi.fn(async (key: string, value: any) => {
      inMemoryStore.set(key, value);
      return 1;
    }),

    del: vi.fn(async (key: string) => {
      const hadKey = inMemoryStore.has(key);
      inMemoryStore.delete(key);
      inMemoryExpiry.delete(key);
      return hadKey ? 1 : 0;
    }),

    incr: vi.fn(async (key: string) => {
      const current = parseInt(inMemoryStore.get(key) || '0');
      const newValue = current + 1;
      inMemoryStore.set(key, newValue);
      return newValue;
    }),

    expire: vi.fn(async (key: string, seconds: number) => {
      if (inMemoryStore.has(key)) {
        inMemoryExpiry.set(key, Date.now() + seconds * 1000);
        return 1;
      }
      return 0;
    }),

    pipeline: vi.fn(() => {
      const commands: Array<{ fn: string; args: any[] }> = [];

      const pipeline: RedisPipeline = {
        get: vi.fn((key: string) => {
          commands.push({ fn: 'get', args: [key] });
          return pipeline;
        }),
        set: vi.fn((key: string, value: any) => {
          commands.push({ fn: 'set', args: [key, value] });
          return pipeline;
        }),
        incr: vi.fn((key: string) => {
          commands.push({ fn: 'incr', args: [key] });
          return pipeline;
        }),
        expire: vi.fn((key: string, seconds: number) => {
          commands.push({ fn: 'expire', args: [key, seconds] });
          return pipeline;
        }),
        exec: vi.fn(async () => {
          const results: any[] = [];
          for (const { fn, args } of commands) {
            if (fn === 'get') {
              results.push(await mock.get(args[0]));
            } else if (fn === 'set') {
              results.push(await mock.set(args[0], args[1]));
            } else if (fn === 'incr') {
              results.push(await mock.incr(args[0]));
            } else if (fn === 'expire') {
              results.push(await mock.expire(args[0], args[1]));
            }
          }
          return results;
        }),
      };

      return pipeline;
    }),

    hget: vi.fn(async (key: string, field: string) => {
      const hash = inMemoryHashes.get(key);
      return hash?.get(field) ?? null;
    }),

    hset: vi.fn(async (key: string, field: string, value: any) => {
      if (!inMemoryHashes.has(key)) {
        inMemoryHashes.set(key, new Map());
      }
      const hash = inMemoryHashes.get(key)!;
      hash.set(field, value);
      return 1;
    }),

    hgetall: vi.fn(async (key: string) => {
      const hash = inMemoryHashes.get(key);
      if (!hash) return {};
      return Object.fromEntries(hash);
    }),

    hdel: vi.fn(async (key: string, field: string) => {
      const hash = inMemoryHashes.get(key);
      if (!hash) return 0;
      const hadField = hash.has(field);
      hash.delete(field);
      return hadField ? 1 : 0;
    }),

    lpush: vi.fn(async (key: string, value: any) => {
      if (!inMemoryLists.has(key)) {
        inMemoryLists.set(key, []);
      }
      const list = inMemoryLists.get(key)!;
      list.unshift(value);
      return list.length;
    }),

    rpop: vi.fn(async (key: string) => {
      const list = inMemoryLists.get(key);
      if (!list || list.length === 0) return null;
      return list.pop();
    }),

    llen: vi.fn(async (key: string) => {
      const list = inMemoryLists.get(key);
      return list?.length ?? 0;
    }),

    lrange: vi.fn(async (key: string, start: number, stop: number) => {
      const list = inMemoryLists.get(key);
      if (!list) return [];
      if (stop === -1) stop = list.length;
      return list.slice(start, stop + 1);
    }),

    sadd: vi.fn(async (key: string, member: string) => {
      if (!inMemorySets.has(key)) {
        inMemorySets.set(key, new Set());
      }
      const set = inMemorySets.get(key)!;
      const hadMember = set.has(member);
      set.add(member);
      return hadMember ? 0 : 1;
    }),

    sismember: vi.fn(async (key: string, member: string) => {
      const set = inMemorySets.get(key);
      return set?.has(member) ? 1 : 0;
    }),

    smembers: vi.fn(async (key: string) => {
      const set = inMemorySets.get(key);
      return set ? Array.from(set) : [];
    }),
  };

  return mock;
}

// ============================================================================
// MOCK DATABASE
// Drizzle-compatible mock database
// ============================================================================

function createMockDatabase(): MockedDatabase {
  const mock: MockedDatabase = {
    select: vi.fn((table: any) => ({
      from: vi.fn((table: any) => mock),
      where: vi.fn((condition: any) => mock),
      limit: vi.fn((limit: number) => mock),
      offset: vi.fn((offset: number) => mock),
      orderBy: vi.fn((...args: any[]) => mock),
      all: vi.fn(async () => []),
      get: vi.fn(async () => null),
    })),

    insert: vi.fn((table: any) => ({
      values: vi.fn((values: any) => mock),
      returning: vi.fn((...args: any[]) => mock),
      run: vi.fn(async () => ({ changes: 1, lastInsertRowid: 1 })),
      get: vi.fn(async () => null),
      all: vi.fn(async () => []),
    })),

    update: vi.fn((table: any) => ({
      set: vi.fn((values: any) => mock),
      where: vi.fn((condition: any) => mock),
      returning: vi.fn((...args: any[]) => mock),
      run: vi.fn(async () => ({ changes: 1 })),
      get: vi.fn(async () => null),
      all: vi.fn(async () => []),
    })),

    delete: vi.fn((table: any) => ({
      where: vi.fn((condition: any) => mock),
      returning: vi.fn((...args: any[]) => mock),
      run: vi.fn(async () => ({ changes: 1 })),
      get: vi.fn(async () => null),
      all: vi.fn(async () => []),
    })),

    transaction: vi.fn(async (fn: any) => {
      // Execute transaction function with mock transaction object
      return await fn({
        select: mock.select,
        insert: mock.insert,
        update: mock.update,
        delete: mock.delete,
      });
    }),

    $client: null,
  };

  return mock;
}

// ============================================================================
// MOCK ABLY
// Realtime messaging mock
// ============================================================================

function createMockAbly(): MockedAbly {
  const channels = new Map<string, MockedAblyChannel>();

  const mock: MockedAbly = {
    channels: {
      get: vi.fn((channelName: string) => {
        if (!channels.has(channelName)) {
          channels.set(channelName, {
            publish: vi.fn(async () => {}),
            subscribe: vi.fn(() => {}),
            unsubscribe: vi.fn(() => {}),
          });
        }
        return channels.get(channelName)!;
      }),
    },

    connect: vi.fn(() => {}),
    disconnect: vi.fn(() => {}),

    connection: {
      state: 'connected',
      on: vi.fn((event: string, callback: any) => {}),
    },
  };

  return mock;
}

// ============================================================================
// MOCK QSTASH
// Upstash QStash mock for async task queues
// ============================================================================

function createMockQStash(): MockedQStash {
  const queue: any[] = [];

  return {
    publish: vi.fn(async (options: any) => {
      queue.push(options);
      return { messageId: `msg_${Date.now()}`, success: true };
    }),

    publishJSON: vi.fn(async (options: any) => {
      queue.push({ ...options, json: true });
      return { messageId: `msg_${Date.now()}`, success: true };
    }),

    enqueue: vi.fn(async (options: any) => {
      queue.push(options);
      return { success: true };
    }),
  };
}

// ============================================================================
// SERVICE PROVIDER MOCKS
// Standardized mocking for service dependencies
// ============================================================================

export interface MockServiceProvider {
  redis: MockedRedis;
  db: MockedDatabase;
  ably: MockedAbly;
  qstash: MockedQStash;
  clock: MockedClock;
}

export interface MockedClock {
  now: MockedFunction<() => number>;
  tick: (ms: number) => void;
  reset: () => void;
}

let globalClock: MockedClock | null = null;

export function mockServiceProvider(): MockServiceProvider {
  // Setup fake timers
  vi.useFakeTimers();

  const clock: MockedClock = {
    now: vi.fn(() => Date.now()),
    tick: (ms: number) => {
      vi.advanceTimersByTime(ms);
    },
    reset: () => {
      vi.useRealTimers();
      vi.useFakeTimers();
    },
  };

  globalClock = clock;

  return {
    redis: createMockRedis(),
    db: createMockDatabase(),
    ably: createMockAbly(),
    qstash: createMockQStash(),
    clock,
  };
}

export function cleanupMocks() {
  vi.useRealTimers();
  vi.clearAllMocks();
  inMemoryStore.clear();
  inMemoryHashes.clear();
  inMemoryLists.clear();
  inMemorySets.clear();
  inMemoryExpiry.clear();
}

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Wait for async operations to complete
 */
export async function waitForAsyncOperations(timeoutMs: number = 100): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, timeoutMs));
}

/**
 * Create a mock correlation ID for tracing
 */
export function createMockCorrelationId(): string {
  return `corr_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a mock trace ID for distributed tracing
 */
export function createMockTraceId(): string {
  return `trace_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a mock idempotency key
 */
export function createMockIdempotencyKey(): string {
  return `idem_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a mock user ID
 */
export function createMockUserId(): string {
  return `user_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a mock execution ID
 */
export function createMockExecutionId(): string {
  return `exec_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// ============================================================================
// VITEST HOOKS
// Auto-cleanup for tests
// ============================================================================

/**
 * Setup test environment before each test
 * Call this in your test setup file or at the start of each test suite
 */
export function setupTestEnvironment(): MockServiceProvider {
  const mocks = mockServiceProvider();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupMocks();
  });

  return mocks;
}

// ============================================================================
// EXPECT HELPERS
// Custom matchers for common assertions
// ============================================================================

export function expectToBeCalledWith(mock: MockedFunction<any>, ...args: any[]) {
  expect(mock).toHaveBeenCalledWith(...args);
}

export function expectToBeCalledTimes(mock: MockedFunction<any>, times: number) {
  expect(mock).toHaveBeenCalledTimes(times);
}

export function expectNotToBeCalled(mock: MockedFunction<any>) {
  expect(mock).not.toHaveBeenCalled();
}

export function expectToReturn(mock: MockedFunction<any>, value: any) {
  expect(mock).toHaveReturnedWith(value);
}

export function expectToThrow(mock: MockedFunction<any>, errorClass: any) {
  expect(mock).toThrow(errorClass);
}

// ============================================================================
// FIXTURES
// Common test data fixtures
// ============================================================================

export const FIXTURES = {
  user: {
    id: 'user_123',
    clerkId: 'clerk_123',
    email: 'test@example.com',
    name: 'Test User',
  },

  booking: {
    id: 'booking_123',
    userId: 'user_123',
    restaurantId: 'restaurant_123',
    tableId: 'table_123',
    partySize: 4,
    dateTime: new Date('2024-01-15T19:00:00Z'),
    status: 'confirmed',
  },

  restaurant: {
    id: 'restaurant_123',
    name: 'Test Restaurant',
    cuisine: 'Italian',
    priceRange: '$$',
    rating: 4.5,
  },

  table: {
    id: 'table_123',
    restaurantId: 'restaurant_123',
    capacity: 4,
    location: 'Main Floor',
  },

  intent: {
    id: 'intent_123',
    userId: 'user_123',
    type: 'book_table',
    status: 'pending',
    parameters: {
      partySize: 4,
      dateTime: '2024-01-15T19:00:00Z',
      cuisine: 'Italian',
    },
  },

  execution: {
    id: 'exec_123',
    intentId: 'intent_123',
    status: 'running',
    steps: [],
    createdAt: new Date(),
  },
};

// ============================================================================
// EXPORTS
// ============================================================================

export type {
  TestContainer,
  MockedRedis,
  MockedDatabase,
  MockedAbly,
  MockedQStash,
  MockedClock,
};
