/**
 * Resilience Logic Unit Tests
 *
 * Tests for CircuitBreaker (comprehensive), IdempotencyService and ReplayGuard (basic structure tests).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from "../services/circuit-breaker";
import { IdempotencyService } from "../idempotency";
import {
  ReplayGuardService,
  isReplayAllowed,
  rollbackReplayGuard,
  isReplayBlockedInRedis,
  createReplayGuardMiddleware,
  getReplayGuard,
  createReplayGuard,
} from "../middleware/web3-replay-guard";

// ============================================================================
// CIRCUIT BREAKER TESTS
// ============================================================================

describe("CircuitBreaker", () => {
  let circuitBreaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    circuitBreaker = new CircuitBreaker("test-service", {
      failureThreshold: 3,
      resetTimeoutMs: 5000,
      successThreshold: 2,
      requestTimeoutMs: 1000,
      debug: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("State Transitions", () => {
    it("should start in CLOSED state", () => {
      expect(circuitBreaker.getState()).toBe("CLOSED");
    });

    it("should transition CLOSED -> OPEN after failure threshold", async () => {
      const stateChanges: string[] = [];
      circuitBreaker.on("stateChange", (from, to) => {
        stateChanges.push(`${from} -> ${to}`);
      });

      // Fail 3 times (threshold)
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(async () => {
            throw new Error("Service unavailable");
          });
        } catch (error) {
          // Expected
        }
      }

      expect(circuitBreaker.getState()).toBe("OPEN");
      expect(stateChanges).toContain("CLOSED -> OPEN");
    });

    it("should transition OPEN -> HALF_OPEN after reset timeout", async () => {
      // Force circuit to OPEN state
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(async () => {
            throw new Error("Service unavailable");
          });
        } catch (error) {
          // Expected
        }
      }

      expect(circuitBreaker.getState()).toBe("OPEN");

      // Advance time past reset timeout (5000ms)
      vi.advanceTimersByTime(6000);

      // Next request should transition to HALF_OPEN
      const stateChanges: string[] = [];
      circuitBreaker.on("stateChange", (from, to) => {
        stateChanges.push(`${from} -> ${to}`);
      });

      await circuitBreaker.execute(async () => "success");

      expect(circuitBreaker.getState()).toBe("HALF_OPEN");
      expect(stateChanges).toContain("OPEN -> HALF_OPEN");
    });

    it("should transition HALF_OPEN -> CLOSED after success threshold", async () => {
      // Force circuit to OPEN state
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(async () => {
            throw new Error("Service unavailable");
          });
        } catch (error) {
          // Expected
        }
      }

      // Advance to HALF_OPEN
      vi.advanceTimersByTime(6000);

      const stateChanges: string[] = [];
      circuitBreaker.on("stateChange", (from, to) => {
        stateChanges.push(`${from} -> ${to}`);
      });

      // Succeed 2 times (success threshold)
      await circuitBreaker.execute(async () => "success1");
      await circuitBreaker.execute(async () => "success2");

      expect(circuitBreaker.getState()).toBe("CLOSED");
      expect(stateChanges).toContain("HALF_OPEN -> CLOSED");
    });

    it("should transition HALF_OPEN -> OPEN on failure", async () => {
      // Force circuit to OPEN state
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(async () => {
            throw new Error("Service unavailable");
          });
        } catch (error) {
          // Expected
        }
      }

      // Advance to HALF_OPEN
      vi.advanceTimersByTime(6000);

      const stateChanges: string[] = [];
      circuitBreaker.on("stateChange", (from, to) => {
        stateChanges.push(`${from} -> ${to}`);
      });

      // Fail in HALF_OPEN
      try {
        await circuitBreaker.execute(async () => {
          throw new Error("Still failing");
        });
      } catch (error) {
        // Expected
      }

      expect(circuitBreaker.getState()).toBe("OPEN");
      expect(stateChanges).toContain("HALF_OPEN -> OPEN");
    });
  });

  describe("Request Execution", () => {
    it("should execute successfully in CLOSED state", async () => {
      const result = await circuitBreaker.execute(async () => "success");
      expect(result).toBe("success");
    });

    it("should reject requests when OPEN", async () => {
      // Force circuit to OPEN state
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(async () => {
            throw new Error("Service unavailable");
          });
        } catch (error) {
          // Expected
        }
      }

      await expect(
        circuitBreaker.execute(async () => "success"),
      ).rejects.toThrow(CircuitBreakerOpenError);
    });

    it("should track statistics correctly", async () => {
      await circuitBreaker.execute(async () => "success");
      await circuitBreaker.execute(async () => "success");

      const stats = circuitBreaker.getStats();
      expect(stats.totalRequests).toBe(2);
      expect(stats.successfulRequests).toBe(2);
      expect(stats.failedRequests).toBe(0);
    });

    it("should respect request timeout", async () => {
      const slowCircuit = new CircuitBreaker("slow-service", {
        failureThreshold: 3,
        resetTimeoutMs: 5000,
        successThreshold: 2,
        requestTimeoutMs: 100,
      });

      const promise = slowCircuit.execute(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return "too slow";
      });

      // Advance timers past the request timeout (100ms)
      vi.advanceTimersByTime(150);

      await expect(promise).rejects.toThrow();
    });
  });

  describe("Error Handling", () => {
    it("should not count ignored errors toward threshold", async () => {
      const circuitWithIgnored = new CircuitBreaker("test", {
        failureThreshold: 3,
        resetTimeoutMs: 5000,
        successThreshold: 2,
        ignoredErrors: ["CLIENT_ERROR"],
      });

      // Fail 5 times with ignored error
      for (let i = 0; i < 5; i++) {
        try {
          await circuitWithIgnored.execute(async () => {
            const error = new Error("Client error") as any;
            error.code = "CLIENT_ERROR";
            throw error;
          });
        } catch (error) {
          // Expected
        }
      }

      // Circuit should still be CLOSED
      expect(circuitWithIgnored.getState()).toBe("CLOSED");
    });
  });
});

// ============================================================================
// IDEMPOTENCY SERVICE TESTS (Basic structure/interface tests only)
// ============================================================================

describe("IdempotencyService", () => {
  describe("interface and structure", () => {
    it("should have isDuplicate method", () => {
      expect(typeof IdempotencyService.prototype.isDuplicate).toBe("function");
    });

    it("should have getKey method", () => {
      expect(typeof IdempotencyService.prototype.getKey).toBe("function");
    });

    it("should have withCausalContext method", () => {
      expect(typeof IdempotencyService.prototype.withCausalContext).toBe(
        "function",
      );
    });

    it("should have getCausalContext method", () => {
      expect(typeof IdempotencyService.prototype.getCausalContext).toBe(
        "function",
      );
    });

    it("should be constructable with Redis client", () => {
      const mockRedis = {
        set: vi.fn().mockResolvedValue("OK"),
        get: vi.fn().mockResolvedValue(null),
      };
      const service = new IdempotencyService(mockRedis as any);
      expect(service).toBeInstanceOf(IdempotencyService);
    });

    it("should accept optional config", () => {
      const mockRedis = {
        set: vi.fn().mockResolvedValue("OK"),
        get: vi.fn().mockResolvedValue(null),
      };
      const service = new IdempotencyService(mockRedis as any, {
        userId: "user-123",
        defaultTtlSeconds: 3600,
        enableCausalKey: true,
      });
      expect(service).toBeInstanceOf(IdempotencyService);
    });
  });

  describe("isDuplicate", () => {
    it("should return false when redis.set succeeds (new key)", async () => {
      const mockRedis = {
        set: vi.fn().mockResolvedValue("OK"),
      };
      const service = new IdempotencyService(mockRedis as any);

      const result = await service.isDuplicate("key1", "action1");

      expect(result).toBe(false);
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringContaining("idempotency:key1"),
        "processed",
        { nx: true, ex: 86400 },
      );
    });

    it("should return true when redis.set returns null (duplicate)", async () => {
      const mockRedis = {
        set: vi.fn().mockResolvedValue(null),
      };
      const service = new IdempotencyService(mockRedis as any);

      const result = await service.isDuplicate("key1", "action1");

      expect(result).toBe(true);
    });

    it("should use custom TTL from config", async () => {
      const mockRedis = {
        set: vi.fn().mockResolvedValue("OK"),
      };
      const service = new IdempotencyService(mockRedis as any, {
        defaultTtlSeconds: 3600,
      });

      await service.isDuplicate("key1", "action1");

      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.any(String),
        "processed",
        { nx: true, ex: 3600 },
      );
    });
  });

  describe("getKey", () => {
    it("should return a key string", async () => {
      const mockRedis = {
        set: vi.fn().mockResolvedValue("OK"),
      };
      const service = new IdempotencyService(mockRedis as any);

      const key = await service.getKey("key1", "action1");

      expect(typeof key).toBe("string");
      expect(key).toContain("idempotency:key1");
    });
  });

  describe("withCausalContext", () => {
    it("should return a new IdempotencyService instance", () => {
      const mockRedis = {
        set: vi.fn().mockResolvedValue("OK"),
      };
      const service = new IdempotencyService(mockRedis as any);

      const childService = service.withCausalContext("parent-123", 42);

      expect(childService).toBeInstanceOf(IdempotencyService);
      expect(childService).not.toBe(service);
    });
  });

  describe("getCausalContext", () => {
    it("should return causal context object", () => {
      const mockRedis = {
        set: vi.fn().mockResolvedValue("OK"),
      };
      const service = new IdempotencyService(mockRedis as any, {
        enableCausalKey: true,
        parentIntentId: "parent-123",
        lamportTimestamp: 42,
      });

      const context = service.getCausalContext();

      expect(context.enableCausalKey).toBe(true);
      expect(context.parentIntentId).toBe("parent-123");
      expect(context.lamportTimestamp).toBe(42);
    });
  });
});

// ============================================================================
// REPLAY GUARD TESTS (Basic structure/interface tests only)
// ============================================================================

describe("ReplayGuard types and exports", () => {
  it("should export ReplayGuardService class", () => {
    expect(ReplayGuardService).toBeDefined();
    expect(typeof ReplayGuardService).toBe("function");
  });

  it("should export isReplayAllowed function", () => {
    expect(isReplayAllowed).toBeDefined();
    expect(typeof isReplayAllowed).toBe("function");
  });

  it("should export rollbackReplayGuard function", () => {
    expect(rollbackReplayGuard).toBeDefined();
    expect(typeof rollbackReplayGuard).toBe("function");
  });

  it("should export isReplayBlockedInRedis function", () => {
    expect(isReplayBlockedInRedis).toBeDefined();
    expect(typeof isReplayBlockedInRedis).toBe("function");
  });

  it("should export createReplayGuardMiddleware function", () => {
    expect(createReplayGuardMiddleware).toBeDefined();
    expect(typeof createReplayGuardMiddleware).toBe("function");
  });

  it("should export getReplayGuard function", () => {
    expect(getReplayGuard).toBeDefined();
    expect(typeof getReplayGuard).toBe("function");
  });

  it("should export createReplayGuard function", () => {
    expect(createReplayGuard).toBeDefined();
    expect(typeof createReplayGuard).toBe("function");
  });
});

describe("ReplayGuardService interface", () => {
  it("should have check method", () => {
    expect(typeof ReplayGuardService.prototype.check).toBe("function");
  });

  it("should have rollback method", () => {
    expect(typeof ReplayGuardService.prototype.rollback).toBe("function");
  });

  it("should have existsInRedis method", () => {
    expect(typeof ReplayGuardService.prototype.existsInRedis).toBe("function");
  });

  it("should have checkBatch method", () => {
    expect(typeof ReplayGuardService.prototype.checkBatch).toBe("function");
  });
});
