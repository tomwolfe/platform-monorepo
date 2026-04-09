/**
 * IntentionEngine - Memory Layer (Refactored)
 * Phase 5: Redis abstraction with namespacing and TTL
 *
 * REFACTOR: This file now re-exports from @repo/shared/src/redis/memory.ts
 * with IntentionEngine-specific namespace and convenience methods.
 *
 * Constraints:
 * - Redis abstraction only
 * - Namespaced keys (intentionengine namespace)
 * - TTL policy
 * - No direct Redis usage elsewhere
 * - Type-safe operations
 */

import {
  MemoryClient as SharedMemoryClient,
  MEMORY_CONFIG as SHARED_MEMORY_CONFIG,
  type MemoryEntry as SharedMemoryEntry,
  type MemoryEntryType as SharedMemoryEntryType,
  type MemoryQuery as SharedMemoryQuery,
} from "@repo/shared/redis/memory";
import { getRedisClient, ServiceNamespace, Logger } from "@repo/shared";
import type { Redis } from "@upstash/redis";
import {
  MemoryEntry,
  MemoryEntrySchema,
  MemoryQuery,
  MemoryQuerySchema,
  MemoryEntryType,
  ExecutionState,
  ExecutionTrace,
  EngineErrorSchema,
} from "./types";
import type { TaskState, TaskStatus } from "@repo/shared";

const logger = new Logger({ serviceName: "intention-engine" });

// Initialize Redis client for MemoryClient
const redis = getRedisClient(ServiceNamespace.IE);

// ============================================================================
// MEMORY CONFIGURATION
// IntentionEngine-specific namespace and TTL overrides
// ============================================================================

export const MEMORY_CONFIG = {
  ...SHARED_MEMORY_CONFIG,
  default_namespace: "intentionengine",
  default_ttl_seconds: 3600, // 1 hour
  max_ttl_seconds: 86400 * 7, // 7 days

  // TTL by entry type (Vercel Hobby Tier Optimization - 24h for execution states)
  ttl_by_type: {
    execution_state: 86400, // 24 hours (Free Tier storage optimization)
    execution_trace: 86400, // 24 hours
    intent_history: 86400 * 3, // 3 days
    plan_cache: 3600, // 1 hour
    tool_result: 1800, // 30 minutes
    user_context: 86400 * 7, // 7 days
    system_config: 0, // No TTL (persistent)
  } as Record<MemoryEntryType, number>,
};

// ============================================================================
// MEMORY ENTRY INPUT TYPE
// Type for store method input (without auto-generated fields)
// ============================================================================

export type MemoryEntryInput = Omit<
  MemoryEntry,
  "key" | "created_at" | "expires_at"
>;

// ============================================================================
// MEMORY CLIENT
// Re-export shared MemoryClient with IntentionEngine namespace
// ============================================================================

export class MemoryClient extends SharedMemoryClient {
  private isAvailable: boolean;

  constructor(namespace: string = MEMORY_CONFIG.default_namespace) {
    super(redis!, namespace);
    // Check if Redis is actually available
    this.isAvailable = !!redis;
    if (!this.isAvailable) {
      logger.warn({
        message:
          "[MemoryClient] Redis client not available. Degrading to stateless mode.",
      });
    }
  }

  /**
   * Override store to handle Redis unavailability gracefully
   */
  async store(entry: MemoryEntryInput): Promise<MemoryEntry> {
    const timestamp = new Date().toISOString();
    const key = this.buildKey(entry.type, entry.namespace);
    const ttlSeconds =
      entry.ttl_seconds ??
      MEMORY_CONFIG.ttl_by_type[entry.type] ??
      MEMORY_CONFIG.default_ttl_seconds;
    const effectiveTtl = Math.min(ttlSeconds, MEMORY_CONFIG.max_ttl_seconds);
    const expiresAt =
      effectiveTtl > 0
        ? new Date(Date.now() + effectiveTtl * 1000).toISOString()
        : undefined;

    const completeEntry: MemoryEntry = MemoryEntrySchema.parse({
      ...entry,
      key,
      created_at: timestamp,
      expires_at: expiresAt,
      ttl_seconds: effectiveTtl > 0 ? effectiveTtl : undefined,
    });

    // RESILIENCE FIX: Gracefully handle Redis unavailability
    if (!this.isAvailable) {
      logger.warn({
        message:
          "[MemoryClient] Redis unavailable, skipping store operation in stateless mode.",
      });
      return completeEntry;
    }

    try {
      // Store in Redis with TTL
      if (effectiveTtl > 0) {
        await this.redis.setex(
          key,
          effectiveTtl,
          JSON.stringify(completeEntry),
        );
      } else {
        // DB-01: Add explicit TTL to prevent memory bloat (30 days for memory entries)
        await this.redis.set(key, JSON.stringify(completeEntry), {
          ex: 86400 * 30,
        });
      }
      return completeEntry;
    } catch (error) {
      throw EngineErrorSchema.parse({
        code: "MEMORY_OPERATION_FAILED",
        message: `Failed to store memory entry: ${error}`,
        details: { key, type: entry.type },
        recoverable: false,
        timestamp,
      });
    }
  }

  /**
   * Override retrieve to handle Redis unavailability gracefully
   */
  async retrieve(key: string): Promise<MemoryEntry | null> {
    if (!this.isAvailable) {
      logger.warn({
        message:
          "[MemoryClient] Redis unavailable, returning null in stateless mode.",
      });
      return null;
    }

    try {
      const data = await this.redis.get<string>(key);
      if (!data) return null;
      const parsed = JSON.parse(data);
      return MemoryEntrySchema.parse(parsed);
    } catch (error) {
      throw EngineErrorSchema.parse({
        code: "MEMORY_OPERATION_FAILED",
        message: `Failed to retrieve memory entry: ${error}`,
        details: { key },
        recoverable: false,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get recent successful intents - preserved from original implementation
   */
  async getRecentSuccessfulIntents(
    limit: number = 3,
  ): Promise<ExecutionState[]> {
    try {
      if (!this.isAvailable && process.env.CI === "true") return [];

      const query: MemoryQuery = {
        namespace: "*",
        type: "execution_state",
        limit: 100,
      };

      const entries = await this.query(query);
      return entries
        .map((e) => e.data as ExecutionState)
        .filter((s) => s.status === "COMPLETED")
        .sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        )
        .slice(0, limit);
    } catch (error) {
      logger.error({
        message: "Failed to get recent successful intents",
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}

// ============================================================================
// EXECUTION STATE STORAGE
// Specialized functions for execution state persistence
// ============================================================================

export class ExecutionStateStorage {
  private memory: MemoryClient;

  constructor(memory?: MemoryClient) {
    this.memory = memory ?? new MemoryClient();
  }

  async saveState(state: ExecutionState): Promise<MemoryEntry> {
    return this.memory.store({
      type: "execution_state",
      namespace: state.execution_id,
      data: state,
      version: 1,
      metadata: {
        status: state.status,
        step_count: state.step_states.length,
      },
    });
  }

  async loadState(executionId: string): Promise<ExecutionState | null> {
    const entry = await this.memory.retrieveByTypeAndId(
      "execution_state",
      executionId,
    );
    return entry ? (entry.data as ExecutionState) : null;
  }

  async deleteState(executionId: string): Promise<boolean> {
    const key = `intentionengine:execution_state:${executionId}`;
    return this.memory.delete(key);
  }
}

// ============================================================================
// EXECUTION TRACE STORAGE
// Specialized functions for trace persistence
// ============================================================================

export class ExecutionTraceStorage {
  private memory: MemoryClient;

  constructor(memory?: MemoryClient) {
    this.memory = memory ?? new MemoryClient();
  }

  async saveTrace(trace: ExecutionTrace): Promise<MemoryEntry> {
    return this.memory.store({
      type: "execution_trace",
      namespace: trace.execution_id,
      data: trace,
      version: 1,
      metadata: {
        entry_count: trace.entries.length,
        total_latency_ms: trace.total_latency_ms,
      },
    });
  }

  async loadTrace(executionId: string): Promise<ExecutionTrace | null> {
    const entry = await this.memory.retrieveByTypeAndId(
      "execution_trace",
      executionId,
    );
    return entry ? (entry.data as ExecutionTrace) : null;
  }

  async appendTraceEntry(
    executionId: string,
    traceEntry: ExecutionTrace["entries"][0],
  ): Promise<void> {
    const existing = await this.loadTrace(executionId);

    if (existing) {
      existing.entries.push(traceEntry);
      existing.total_latency_ms =
        (existing.total_latency_ms || 0) + (traceEntry.latency_ms || 0);
      await this.saveTrace(existing);
    } else {
      const newTrace: ExecutionTrace = {
        trace_id: executionId,
        execution_id: executionId,
        entries: [traceEntry],
        started_at: traceEntry.timestamp,
        total_latency_ms: traceEntry.latency_ms,
      };
      await this.saveTrace(newTrace);
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let defaultMemoryClient: MemoryClient | null = null;

export function getMemoryClient(): MemoryClient {
  if (!defaultMemoryClient) {
    defaultMemoryClient = new MemoryClient();
  }
  return defaultMemoryClient;
}

export function getMemoryClientSafe(): MemoryClient | null {
  try {
    return getMemoryClient();
  } catch (error) {
    logger.warn({
      message: "[MemoryClient] Redis unavailable, returning null",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export async function saveExecutionState(
  state: ExecutionState,
  useOCC: boolean = true,
  options?: {
    maxRetries?: number;
    baseDelayMs?: number;
    debug?: boolean;
  },
): Promise<
  | MemoryEntry
  | { success: boolean; version?: number; attempts: number; error?: string }
> {
  if (useOCC) {
    // Use the locally exported getMemoryClient instead of dynamic require
    // This avoids circular dependency issues and enables proper static analysis
    const sharedMemory = getMemoryClient();

    return sharedMemory.saveStateWithOCC(state.execution_id, state, options);
  }

  const storage = new ExecutionStateStorage();
  const entry = await storage.saveState(state);

  // CRITICAL: Verify the state was actually persisted.
  // If Redis is down, MemoryClient.store() may return the entry without
  // persisting it. We must verify persistence and throw if it failed,
  // so the orchestrator halts rather than continuing with amnesia
  // (which breaks the Saga compensation pattern).
  const verified = await storage.loadState(state.execution_id);
  if (!verified) {
    throw new Error(
      `[ExecutionStateStorage] State persistence verification failed for execution ${state.execution_id}. ` +
        "The storage backend may be unavailable. Halting execution to prevent Saga compensation errors.",
    );
  }

  return entry;
}

export async function loadExecutionState(
  executionId: string,
): Promise<ExecutionState | null> {
  const storage = new ExecutionStateStorage();
  return storage.loadState(executionId);
}

export async function saveExecutionTrace(
  trace: ExecutionTrace,
): Promise<MemoryEntry> {
  const storage = new ExecutionTraceStorage();
  const entry = await storage.saveTrace(trace);

  // Verify persistence for traces as well
  const verified = await storage.loadTrace(trace.execution_id);
  if (!verified) {
    throw new Error(
      `[ExecutionTraceStorage] Trace persistence verification failed for execution ${trace.execution_id}. ` +
        "The storage backend may be unavailable.",
    );
  }

  return entry;
}

export async function loadExecutionTrace(
  executionId: string,
): Promise<ExecutionTrace | null> {
  const storage = new ExecutionTraceStorage();
  return storage.loadTrace(executionId);
}

// Re-export types
export type { MemoryEntry, MemoryQuery, MemoryEntryType };
