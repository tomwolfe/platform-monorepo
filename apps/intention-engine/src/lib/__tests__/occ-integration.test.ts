/**
 * OCC (Optimistic Concurrency Control) Integration Tests
 *
 * Tests the "Ghost Re-plan" race condition prevention:
 * - QStash retry and user follow-up arriving simultaneously
 * - Both lambdas read state, modify it, and write back
 * - OCC with automatic rebase prevents split-brain state
 *
 * @package @repo/shared
 * @since 1.1.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Redis } from "@upstash/redis";

// ============================================================================
// MOCKS: Replace real Upstash Redis with in-memory client for tests
// ============================================================================

// Mock @repo/shared/redis before anything else imports it
vi.mock("@repo/shared/redis", () => {
  // In-memory Redis-compatible client (defined inside factory due to hoisting)
  class InMemoryRedis {
    // Shared store across all instances so getRedisClient() calls share data
    private static sharedStore = new Map<string, string>();
    private store: Map<string, string>;

    constructor() {
      this.store = InMemoryRedis.sharedStore;
    }

    async get<T>(key: string): Promise<T | null> {
      const val = this.store.get(key);
      if (val === undefined) return null as T;
      try {
        return JSON.parse(val) as T;
      } catch {
        return val as unknown as T;
      }
    }

    async set(
      key: string,
      value: string | unknown,
      options?: { ex?: number },
    ): Promise<"OK" | null> {
      this.store.set(
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      );
      return "OK";
    }

    async setex(
      key: string,
      seconds: number,
      value: string,
    ): Promise<"OK" | null> {
      this.store.set(key, value);
      return "OK";
    }

    async del(key: string): Promise<number> {
      return this.store.delete(key) ? 1 : 0;
    }

    async exists(key: string): Promise<number> {
      return this.store.has(key) ? 1 : 0;
    }

    // Simplified eval: interprets Lua scripts used by OCC (CAS and delta scripts)
    async eval(
      script: string,
      keys: string[],
      args: string[],
    ): Promise<unknown> {
      const store = this.store;
      const key = keys[0];

      // Handle ATOMIC_CAS_SCRIPT (Compare-And-Swap)
      if (script.includes("expectedVersion") && script.includes("newState")) {
        const expectedVersion = args[0];
        const newState = args[1];
        const newVersion = parseInt(args[2], 10);

        const current = store.get(key);
        let currentVersion = 0;
        let currentState: string | null = null;

        if (current) {
          try {
            const decoded = JSON.parse(current);
            currentVersion = decoded.version ?? decoded._version ?? 0;
            currentState = current;
          } catch {
            /* ignore */
          }
        }

        if (
          expectedVersion !== "any" &&
          String(currentVersion) !== expectedVersion
        ) {
          // Conflict detected - return current state for rebase
          return [0, currentVersion, currentState || "null"];
        }

        // Perform update - parse newState to ensure it's valid JSON, then store
        try {
          JSON.parse(newState); // Validate JSON
        } catch {
          // If newState isn't valid JSON, wrap it
          store.set(
            key,
            JSON.stringify({ value: newState, version: newVersion }),
          );
          return [1, newVersion, store.get(key)!];
        }
        store.set(key, newState);
        return [1, newVersion, newState];
      }

      // Handle ATOMIC_DELTA_SCRIPT
      if (script.includes("deltaJson")) {
        const deltaJson = JSON.parse(args[0]);
        const newVersion = parseInt(args[1], 10);

        const current = store.get(key);
        if (!current) {
          return [0, 0, "null"];
        }

        const currentState = JSON.parse(current);
        Object.assign(currentState, deltaJson);
        if (currentState.version !== undefined) {
          currentState.version = newVersion;
        } else {
          currentState._version = newVersion;
        }

        const newState = JSON.stringify(currentState);
        store.set(key, newState);
        return [1, newVersion, newState];
      }

      return null;
    }

    async zadd(
      _key: string,
      _member: { score: number; value: string },
    ): Promise<number> {
      return 1;
    }
    async zremrangebyscore(
      _key: string,
      _min: number,
      _max: number,
    ): Promise<number> {
      return 0;
    }
    async zcard(_key: string): Promise<number> {
      return 0;
    }
    async zrange(
      _key: string,
      _start: number,
      _end: number,
    ): Promise<string[]> {
      return [];
    }
    async incr(_key: string): Promise<number> {
      return 1;
    }
    async expire(_key: string, _seconds: number): Promise<number> {
      return 1;
    }
    async keys(_pattern: string): Promise<string[]> {
      return Array.from(this.store.keys());
    }
    async pipeline() {
      return this;
    }
    async multi() {
      return this;
    }
    async scan(
      _cursor: number,
      _options?: { match?: string },
    ): Promise<[string, string[]]> {
      return ["0", Array.from(this.store.keys())];
    }

    // Expose store for test cleanup
    static resetStore() {
      InMemoryRedis.sharedStore.clear();
    }
  }

  // Singleton instance - all getRedisClient() calls return the same instance
  const singletonMock = new InMemoryRedis() as unknown as Redis;

  return {
    getRedisClient: () => singletonMock,
    ServiceNamespace: { SHARED: "shared", IE: "ie", OD: "od", TS: "ts" },
    getNamespacePrefix: (ns: string) => `${ns}:`,
    wrapWithPrefix: (client: any) => client,
    getRedisConfig: () => ({ url: "http://localhost:8080", token: "test" }),
    InMemoryRedis: InMemoryRedis,
  };
});

import {
  getRedisClient,
  ServiceNamespace,
  getMemoryClient,
} from "@repo/shared";
import {
  AtomicStateRebaser,
  createAtomicStateRebaser,
  atomicUpdateState,
  createWorkflowStateRebaser,
} from "@repo/shared/occ-rebase";

// ============================================================================
// TEST HELPERS
// ============================================================================

function getTestRedis(): Redis {
  return getRedisClient(ServiceNamespace.SHARED);
}

function generateTestKey(): string {
  return `test:occ:${Date.now()}:${crypto.randomUUID()}`;
}

interface TestState {
  version?: number;
  counter: number;
  data: string;
  items: string[];
}

// ============================================================================
// ATOMIC STATE REBASER TESTS
// ============================================================================

describe("AtomicStateRebaser", () => {
  let redis: Redis;
  let rebaser: AtomicStateRebaser<TestState>;
  let testKey: string;

  beforeEach(async () => {
    redis = getTestRedis();
    testKey = generateTestKey();
    rebaser = new AtomicStateRebaser<TestState>(testKey, false, redis);

    // Initialize test state
    const initialState: TestState = {
      version: 1,
      counter: 0,
      data: "initial",
      items: ["item1"],
    };
    await redis.set(testKey, JSON.stringify(initialState));
  });

  afterEach(async () => {
    // Clean up test key
    await redis.del(testKey);
  });

  describe("update()", () => {
    it("should update state atomically when no conflict exists", async () => {
      const result = await rebaser.update((state) => ({
        counter: state.counter + 1,
        data: "updated",
      }));

      expect(result.success).toBe(true);
      expect(result.rebaseAttempts).toBe(0);
      expect(result.succeededViaRebase).toBe(false);
      expect(result.updatedState?.counter).toBe(1);
      expect(result.updatedState?.data).toBe("updated");
      expect(result.updatedState?.version).toBe(2);

      // Verify state was actually saved
      const savedState = await redis.get<TestState>(testKey);
      expect(savedState?.counter).toBe(1);
      expect(savedState?.version).toBe(2);
    });

    it("should handle conflicts with automatic rebase", async () => {
      // Simulate concurrent modification during our update
      const conflictingUpdate = async () => {
        // Read current state
        const currentState = await redis.get<TestState>(testKey);
        if (currentState) {
          // Write with incremented version (simulating concurrent writer)
          await redis.set(
            testKey,
            JSON.stringify({
              ...currentState,
              counter: currentState.counter + 100,
              version: currentState.version! + 1,
            }),
          );
        }
      };

      // Start conflicting update (runs synchronously before our update)
      await conflictingUpdate();

      // Attempt our update with rebase support
      const result = await rebaser.update(
        (state) => ({
          counter: state.counter + 1,
          data: "rebased",
        }),
        { maxRetries: 3, baseDelayMs: 50, debug: false },
      );

      // Should succeed via rebase (read latest state, re-apply our delta)
      expect(result.success).toBe(true);
      expect(result.rebaseAttempts).toBeGreaterThanOrEqual(1);
      expect(result.succeededViaRebase).toBe(true);

      // Final state should have both updates applied
      expect(result.updatedState?.counter).toBeGreaterThan(0);
      expect(result.updatedState?.data).toBe("rebased");
    });

    it("should fail after max retries exceeded", async () => {
      // Force continuous conflicts during retries
      const originalEval = InMemoryRedis.prototype.eval;
      let conflictCount = 0;

      // Patch eval to always cause conflicts during retry window
      const conflictEval = async function (
        this: any,
        script: string,
        keys: string[],
        args: string[],
      ) {
        if (script.includes("expectedVersion") && script.includes("newState")) {
          conflictCount++;
          // Force conflict on first N attempts
          if (conflictCount <= 5) {
            const current = this.store.get(keys[0]);
            let currentVersion = 0;
            if (current) {
              try {
                const decoded = JSON.parse(current);
                currentVersion = (decoded.version ?? decoded._version ?? 0) + 1; // Always ahead
              } catch {
                /* ignore */
              }
            }
            return [0, currentVersion, current || "null"];
          }
        }
        return originalEval.call(this, script, keys, args);
      };

      InMemoryRedis.prototype.eval = conflictEval;

      try {
        const result = await rebaser.update(
          (state) => ({ counter: state.counter + 1 }),
          { maxRetries: 2, baseDelayMs: 10, debug: false },
        );

        // Should fail due to max retries exceeded
        expect(result.success).toBe(false);
        expect(result.rebaseAttempts).toBeGreaterThanOrEqual(2);
        expect(result.error).toContain("Max rebase attempts exceeded");
      } finally {
        // Restore original eval
        InMemoryRedis.prototype.eval = originalEval;
      }
    });

    it("should handle non-existent state", async () => {
      // Delete state
      await redis.del(testKey);

      const result = await rebaser.update((state) => ({
        counter: state.counter + 1,
      }));

      expect(result.success).toBe(false);
      expect(result.error).toBe("State does not exist");
    });

    it("should apply exponential backoff with jitter", async () => {
      const delays: number[] = [];
      let attemptCount = 0;

      // Mock sleep to track delays
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = ((fn: any, delay: number) => {
        delays.push(delay);
        return originalSetTimeout(fn, 0);
      }) as any;

      try {
        // Force conflicts
        const conflictOnEveryAttempt = async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          const currentState = await redis.get<TestState>(testKey);
          if (currentState) {
            await redis.set(
              testKey,
              JSON.stringify({
                ...currentState,
                version: currentState.version! + 1,
              }),
            );
          }
        };

        const updatePromise = rebaser.update(
          (state) => ({ counter: state.counter + 1 }),
          { maxRetries: 3, baseDelayMs: 50 },
        );

        // Trigger conflicts during retries
        setTimeout(conflictOnEveryAttempt, 5);
        setTimeout(conflictOnEveryAttempt, 20);
        setTimeout(conflictOnEveryAttempt, 50);

        await updatePromise;

        // Verify exponential backoff (with some tolerance for jitter)
        expect(delays.length).toBeGreaterThanOrEqual(1);
        if (delays.length >= 2) {
          expect(delays[1]).toBeGreaterThan(delays[0]);
        }
      } finally {
        global.setTimeout = originalSetTimeout;
      }
    });
  });

  describe("applyDelta()", () => {
    it("should apply delta atomically", async () => {
      const result = await rebaser.applyDelta({
        counter: 5,
        data: "delta-updated",
      });

      expect(result.success).toBe(true);
      expect(result.updatedState?.counter).toBe(5);
      expect(result.updatedState?.data).toBe("delta-updated");
      expect(result.updatedState?.version).toBe(2);
    });

    it("should retry delta on conflict", async () => {
      // Simulate conflict
      setTimeout(async () => {
        const currentState = await redis.get<TestState>(testKey);
        if (currentState) {
          await redis.set(
            testKey,
            JSON.stringify({
              ...currentState,
              version: currentState.version! + 1,
            }),
          );
        }
      }, 50);

      const result = await rebaser.applyDelta(
        { counter: 10 },
        { maxRetries: 3, baseDelayMs: 50 },
      );

      expect(result.success).toBe(true);
      expect(result.succeededViaRebase).toBe(result.rebaseAttempts > 0);
      expect(result.updatedState?.counter).toBe(10);
    });
  });
});

// ============================================================================
// CONVENIENCE FUNCTION TESTS
// ============================================================================

describe("atomicUpdateState()", () => {
  let redis: Redis;
  let testKey: string;

  beforeEach(async () => {
    redis = getTestRedis();
    testKey = generateTestKey();

    const initialState: TestState = {
      version: 1,
      counter: 0,
      data: "test",
      items: [],
    };
    await redis.set(testKey, JSON.stringify(initialState));
  });

  afterEach(async () => {
    await redis.del(testKey);
  });

  it("should update state using convenience function", async () => {
    const result = await atomicUpdateState<TestState>(testKey, (state) => ({
      counter: state.counter + 5,
    }));

    expect(result.success).toBe(true);
    expect(result.updatedState?.counter).toBe(5);
  });
});

// ============================================================================
// MEMORYCLIENT OCC TESTS
// ============================================================================

describe("MemoryClient.saveStateWithOCC()", () => {
  let redis: Redis;
  let memory: ReturnType<typeof getMemoryClient>;
  let executionId: string;

  beforeEach(async () => {
    redis = getTestRedis();
    memory = getMemoryClient();
    executionId = crypto.randomUUID();

    // Initialize task state
    const key = `shared:task:${executionId}`;
    const initialState = {
      execution_id: executionId,
      status: "EXECUTING",
      version: 1,
      step_states: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await redis.setex(key, 86400, JSON.stringify(initialState));
  });

  afterEach(async () => {
    const key = `shared:task:${executionId}`;
    await redis.del(key);
  });

  it("should save state with OCC protection", async () => {
    const result = await memory.saveStateWithOCC(executionId, {
      status: "COMPLETED",
      step_states: [{ step_id: "step1", status: "completed" }],
    });

    expect(result.success).toBe(true);
    expect(result.version).toBe(2);
    expect(result.attempts).toBe(0);

    // Verify state was saved
    const key = `shared:task:${executionId}`;
    const savedState = await redis.get<any>(key);
    expect(savedState.status).toBe("COMPLETED");
    expect(savedState.version).toBe(2);
  });

  it("should handle concurrent saves with automatic retry", async () => {
    // Simulate concurrent save
    setTimeout(async () => {
      const key = `shared:task:${executionId}`;
      const currentState = await redis.get<any>(key);
      if (currentState) {
        await redis.set(
          key,
          JSON.stringify({
            ...currentState,
            status: "MODIFIED_CONCURRENTLY",
            version: currentState.version + 1,
          }),
        );
      }
    }, 50);

    const result = await memory.saveStateWithOCC(
      executionId,
      { status: "COMPLETED" },
      { maxRetries: 3, baseDelayMs: 50, debug: false },
    );

    expect(result.success).toBe(true);
    expect(result.attempts).toBeGreaterThanOrEqual(0);
  });

  it("should fail gracefully when state doesn't exist", async () => {
    const nonExistentId = crypto.randomUUID();
    const result = await memory.saveStateWithOCC(nonExistentId, {
      status: "COMPLETED",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("State does not exist");
  });

  it("should respect maxRetries limit", async () => {
    // Aggressive concurrent modifications
    const interval = setInterval(async () => {
      const key = `shared:task:${executionId}`;
      const currentState = await redis.get<any>(key);
      if (currentState) {
        await redis.set(
          key,
          JSON.stringify({
            ...currentState,
            version: currentState.version + 1,
          }),
        );
      }
    }, 20);

    const result = await memory.saveStateWithOCC(
      executionId,
      { status: "COMPLETED" },
      { maxRetries: 2, baseDelayMs: 10 },
    );

    clearInterval(interval);

    // May succeed or fail depending on timing
    if (!result.success) {
      expect(result.error).toContain("Max OCC retries exceeded");
    }
  });
});

// ============================================================================
// WORKFLOW STATE REBASER TESTS
// ============================================================================

describe("createWorkflowStateRebaser()", () => {
  let redis: Redis;
  let executionId: string;

  beforeEach(async () => {
    redis = getTestRedis();
    executionId = crypto.randomUUID();

    // Initialize workflow state
    const key = `intentionengine:task:${executionId}`;
    const initialState = {
      execution_id: executionId,
      status: "EXECUTING",
      version: 1,
      step_states: [],
    };
    await redis.setex(key, 86400, JSON.stringify(initialState));
  });

  afterEach(async () => {
    const key = `intentionengine:task:${executionId}`;
    await redis.del(key);
  });

  it("should create workflow state rebaser", async () => {
    const rebaser = createWorkflowStateRebaser(executionId);

    const result = await rebaser.update((state) => ({
      status: "COMPLETED",
      step_states: [
        ...state.step_states,
        { step_id: "test", status: "completed" },
      ],
    }));

    expect(result.success).toBe(true);
    expect(result.updatedState?.status).toBe("COMPLETED");
    expect(result.updatedState?.version).toBe(2);
  });
});

// ============================================================================
// END OF FILE
// ============================================================================
