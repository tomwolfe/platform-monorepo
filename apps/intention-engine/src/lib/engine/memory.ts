/**
 * IntentionEngine - Memory Layer
 * Phase 5: Redis abstraction with namespacing and TTL
 * 
 * Constraints:
 * - Redis abstraction only
 * - Namespaced keys
 * - TTL policy
 * - No direct Redis usage elsewhere
 * - Type-safe operations
 */

import { redis } from "../redis-client";
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

// ============================================================================
// MEMORY CONFIGURATION
// Default TTL and namespace settings
// ============================================================================

export const MEMORY_CONFIG = {
  default_namespace: "intentionengine",
  default_ttl_seconds: 3600, // 1 hour
  max_ttl_seconds: 86400 * 7, // 7 days
  key_separator: ":",

  // TTL by entry type (Vercel Hobby Tier Optimization - 24h for execution states)
  ttl_by_type: {
    execution_state: 86400,     // 24 hours (Free Tier storage optimization)
    execution_trace: 86400,     // 24 hours
    intent_history: 86400 * 3,  // 3 days
    plan_cache: 3600,           // 1 hour
    tool_result: 1800,          // 30 minutes
    user_context: 86400 * 7,    // 7 days
    system_config: 0,           // No TTL (persistent)
  } as Record<MemoryEntryType, number>,
};

// ============================================================================
// MEMORY ENTRY INPUT TYPE
// Type for store method input (without auto-generated fields)
// ============================================================================

export type MemoryEntryInput = Omit<MemoryEntry, "key" | "created_at" | "expires_at">;

// ============================================================================
// MEMORY CLIENT
// Redis client wrapper with type safety
// ============================================================================

export class MemoryClient {
  private redis: Redis;
  private namespace: string;
  private isAvailable: boolean;

  constructor(namespace: string = MEMORY_CONFIG.default_namespace) {
    this.redis = redis;
    this.namespace = namespace;
    // Check if Redis is actually available
    this.isAvailable = !!redis;
    if (!this.isAvailable) {
      console.warn('[MemoryClient] Redis client not available. Degrading to stateless mode.');
    }
  }

  // ========================================================================
  // KEY GENERATION
  // Build namespaced keys
  // ========================================================================

  private buildKey(type: MemoryEntryType, id: string): string {
    return `${this.namespace}${MEMORY_CONFIG.key_separator}${type}${MEMORY_CONFIG.key_separator}${id}`;
  }

  private parseKey(key: string): { namespace: string; type: string; id: string } | null {
    const parts = key.split(MEMORY_CONFIG.key_separator);
    if (parts.length !== 3) return null;
    return {
      namespace: parts[0],
      type: parts[1],
      id: parts[2],
    };
  }

  // ========================================================================
  // STORE ENTRY
  // Store a memory entry with automatic TTL
  // ========================================================================

  async store(entry: MemoryEntryInput): Promise<MemoryEntry> {
    const timestamp = new Date().toISOString();

    // Generate key
    const key = this.buildKey(entry.type, entry.namespace);

    // Calculate TTL
    const ttlSeconds = entry.ttl_seconds ?? MEMORY_CONFIG.ttl_by_type[entry.type] ?? MEMORY_CONFIG.default_ttl_seconds;

    // Validate TTL doesn't exceed maximum
    const effectiveTtl = Math.min(ttlSeconds, MEMORY_CONFIG.max_ttl_seconds);

    // Calculate expiration
    const expiresAt = effectiveTtl > 0
      ? new Date(Date.now() + effectiveTtl * 1000).toISOString()
      : undefined;

    // Build complete entry
    const completeEntry: MemoryEntry = MemoryEntrySchema.parse({
      ...entry,
      key,
      created_at: timestamp,
      expires_at: expiresAt,
      ttl_seconds: effectiveTtl > 0 ? effectiveTtl : undefined,
    });

    try {
      // RESILIENCE FIX: Gracefully handle Redis unavailability
      if (!this.isAvailable) {
        console.warn('[MemoryClient] Redis unavailable, skipping store operation in stateless mode.');
        return completeEntry; // Return entry without persisting
      }

      // Store in Redis with TTL
      if (effectiveTtl > 0) {
        await this.redis.setex(key, effectiveTtl, JSON.stringify(completeEntry));
      } else {
        await this.redis.set(key, JSON.stringify(completeEntry));
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

  // ========================================================================
  // RETRIEVE ENTRY
  // Get a memory entry by key
  // ========================================================================

  async retrieve(key: string): Promise<MemoryEntry | null> {
    // RESILIENCE FIX: Gracefully handle Redis unavailability
    if (!this.isAvailable) {
      console.warn('[MemoryClient] Redis unavailable, returning null in stateless mode.');
      return null;
    }

    try {
      const data = await this.redis.get<string>(key);

      if (!data) {
        return null;
      }

      // Parse and validate
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

  // ========================================================================
  // RETRIEVE BY TYPE AND ID
  // Convenience method for retrieving by type and id
  // ========================================================================

  async retrieveByTypeAndId(type: MemoryEntryType, id: string): Promise<MemoryEntry | null> {
    const key = this.buildKey(type, id);
    return this.retrieve(key);
  }

  // ========================================================================
  // DELETE ENTRY
  // Remove a memory entry
  // ========================================================================

  async delete(key: string): Promise<boolean> {
    try {
      const result = await this.redis.del(key);
      return result > 0;
    } catch (error) {
      throw EngineErrorSchema.parse({
        code: "MEMORY_OPERATION_FAILED",
        message: `Failed to delete memory entry: ${error}`,
        details: { key },
        recoverable: false,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ========================================================================
  // QUERY ENTRIES
  // Query memory entries by criteria
  // ========================================================================

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    try {
      // Build pattern for scan
      const pattern = query.type
        ? `${query.namespace}${MEMORY_CONFIG.key_separator}${query.type}${MEMORY_CONFIG.key_separator}*`
        : `${query.namespace}${MEMORY_CONFIG.key_separator}*`;

      // Scan for matching keys
      const keys: string[] = [];
      let cursor = 0;
      
      do {
        const result = await this.redis.scan(cursor, {
          match: pattern,
          count: 100,
        });
        
        cursor = parseInt(result[0] as string, 10);
        keys.push(...(result[1] as string[]));
      } while (cursor !== 0);

      // Retrieve all entries
      const entries: MemoryEntry[] = [];
      
      for (const key of keys.slice(0, query.limit)) {
        const entry = await this.retrieve(key);
        if (entry) {
          // Filter by time range if specified
          if (query.after && entry.created_at < query.after) continue;
          if (query.before && entry.created_at > query.before) continue;
          
          entries.push(entry);
        }
      }

      return entries;
    } catch (error) {
      throw EngineErrorSchema.parse({
        code: "MEMORY_OPERATION_FAILED",
        message: `Failed to query memory entries: ${error}`,
        details: { query },
        recoverable: false,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ========================================================================
  // UPDATE TTL
  // Update the TTL of an existing entry
  // ========================================================================

  async updateTtl(key: string, newTtlSeconds: number): Promise<boolean> {
    try {
      const entry = await this.retrieve(key);
      
      if (!entry) {
        return false;
      }

      // Validate new TTL
      const effectiveTtl = Math.min(newTtlSeconds, MEMORY_CONFIG.max_ttl_seconds);
      
      // Update entry with new TTL
      const updatedEntry: MemoryEntry = {
        ...entry,
        ttl_seconds: effectiveTtl,
        expires_at: new Date(Date.now() + effectiveTtl * 1000).toISOString(),
      };

      // Store with new TTL
      await this.redis.setex(key, effectiveTtl, JSON.stringify(updatedEntry));
      
      return true;
    } catch (error) {
      throw EngineErrorSchema.parse({
        code: "MEMORY_OPERATION_FAILED",
        message: `Failed to update TTL: ${error}`,
        details: { key, newTtlSeconds },
        recoverable: false,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ========================================================================
  // GET TTL
  // Get remaining TTL for an entry
  // ========================================================================

  async getTtl(key: string): Promise<number> {
    try {
      return await this.redis.ttl(key);
    } catch (error) {
      throw EngineErrorSchema.parse({
        code: "MEMORY_OPERATION_FAILED",
        message: `Failed to get TTL: ${error}`,
        details: { key },
        recoverable: false,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ========================================================================
  // EXISTS
  // Check if an entry exists
  // ========================================================================

  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.redis.exists(key);
      return result === 1;
    } catch (error) {
      throw EngineErrorSchema.parse({
        code: "MEMORY_OPERATION_FAILED",
        message: `Failed to check existence: ${error}`,
        details: { key },
        recoverable: false,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ========================================================================
  // COUNTER OPERATIONS
  // Atomic increment and retrieval for circuit breakers
  // ========================================================================

  async incrementCounter(key: string, ttlSeconds: number): Promise<number> {
    try {
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, ttlSeconds);
      }
      return count;
    } catch (error) {
      console.error(`Failed to increment counter for ${key}:`, error);
      return 0; // Fallback to 0 if Redis fails
    }
  }

  async getCounter(key: string): Promise<number> {
    try {
      const count = await this.redis.get<number>(key);
      return count || 0;
    } catch (error) {
      console.error(`Failed to get counter for ${key}:`, error);
      return 0;
    }
  }

  async getRecentSuccessfulIntents(limit: number = 3): Promise<ExecutionState[]> {
    try {
      // Fail-open in CI/test environments if Redis is unavailable
      if (!this.isAvailable && process.env.CI === "true") return [];
      
      // This is a simplified query. In a real system, we'd use a separate index or list for successful intents.
      // For now, we query execution states and filter.
      const query: MemoryQuery = {
        namespace: "*",
        type: "execution_state",
        limit: 100, // Search through last 100 to find successful ones
      };

      const entries = await this.query(query);
      return entries
        .map(e => e.data as ExecutionState)
        .filter(s => s.status === "COMPLETED")
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, limit);
    } catch (error) {
      console.error("Failed to get recent successful intents:", error);
      return []; // Return empty instead of throwing to avoid 503
    }
  }

  // ========================================================================
  // TASK STATE METHODS
  // Methods for TaskState management (durable execution)
  // ========================================================================

  async getTaskState(executionId: string): Promise<TaskState | null> {
    const key = `${this.namespace}:task:${executionId}`;

    try {
      const data = await this.redis.get<string>(key);
      if (!data) return null;
      return JSON.parse(data) as TaskState;
    } catch (error) {
      console.error(`Failed to get task state for ${executionId}:`, error);
      return null;
    }
  }

  async createTaskState(taskState: TaskState): Promise<void> {
    const key = `${this.namespace}:task:${taskState.execution_id}`;

    try {
      await this.redis.setex(key, 86400, JSON.stringify(taskState));
    } catch (error) {
      console.error(`Failed to create task state for ${taskState.execution_id}:`, error);
      throw error;
    }
  }

  async transitionTaskState(
    executionId: string,
    toStatus: TaskStatus,
    reason?: string
  ): Promise<boolean> {
    const key = `${this.namespace}:task:${executionId}`;

    try {
      const currentState = await this.getTaskState(executionId);
      if (!currentState) return false;

      const transition = {
        from_status: currentState.status,
        to_status: toStatus,
        timestamp: new Date().toISOString(),
        reason,
      };

      const updatedState: TaskState = {
        ...currentState,
        status: toStatus,
        transitions: [...currentState.transitions, transition],
        updated_at: new Date().toISOString(),
      };

      if (toStatus === "completed") {
        updatedState.completed_at = new Date().toISOString();
      }

      await this.redis.setex(key, 86400, JSON.stringify(updatedState));
      return true;
    } catch (error) {
      console.error(`Failed to transition task state for ${executionId}:`, error);
      return false;
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
    const entry = await this.memory.retrieveByTypeAndId("execution_state", executionId);
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
    const entry = await this.memory.retrieveByTypeAndId("execution_trace", executionId);
    return entry ? (entry.data as ExecutionTrace) : null;
  }

  async appendTraceEntry(
    executionId: string,
    traceEntry: ExecutionTrace["entries"][0]
  ): Promise<void> {
    const existing = await this.loadTrace(executionId);
    
    if (existing) {
      existing.entries.push(traceEntry);
      existing.total_latency_ms = (existing.total_latency_ms || 0) + (traceEntry.latency_ms || 0);
      await this.saveTrace(existing);
    } else {
      // Create new trace
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
// Default memory client for general use
// ============================================================================

let defaultMemoryClient: MemoryClient | null = null;

/**
 * Get Memory Client - Enhanced with explicit Redis availability check
 *
 * @returns MemoryClient instance (may operate in degraded mode if Redis unavailable)
 */
export function getMemoryClient(): MemoryClient {
  if (!defaultMemoryClient) {
    defaultMemoryClient = new MemoryClient();
  }
  return defaultMemoryClient;
}

/**
 * Get Memory Client Safely - Returns null if Redis is unavailable
 * 
 * @returns MemoryClient instance or null
 */
export function getMemoryClientSafe(): MemoryClient | null {
  try {
    return getMemoryClient();
  } catch (error) {
    console.warn('[MemoryClient] Redis unavailable, returning null:', error instanceof Error ? error.message : error);
    return null;
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// Convenience exports
// ============================================================================

/**
 * Save execution state with OCC protection against race conditions.
 * This is the preferred method for saving state in production.
 *
 * @param state - Execution state to save
 * @param useOCC - Enable OCC with automatic retry (default: true)
 * @param options - OCC options
 */
export async function saveExecutionState(
  state: ExecutionState,
  useOCC: boolean = true,
  options?: {
    maxRetries?: number;
    baseDelayMs?: number;
    debug?: boolean;
  }
): Promise<MemoryEntry | { success: boolean; version?: number; attempts: number; error?: string }> {
  // Use OCC-aware save for production safety
  if (useOCC) {
    const { getMemoryClient } = require('@repo/shared');
    const sharedMemory = getMemoryClient();

    return sharedMemory.saveStateWithOCC(
      state.execution_id,
      state,
      options
    );
  }

  // Fallback to simple save (for testing/development)
  const storage = new ExecutionStateStorage();
  return storage.saveState(state);
}

export async function loadExecutionState(executionId: string): Promise<ExecutionState | null> {
  const storage = new ExecutionStateStorage();
  return storage.loadState(executionId);
}

export async function saveExecutionTrace(trace: ExecutionTrace): Promise<MemoryEntry> {
  const storage = new ExecutionTraceStorage();
  return storage.saveTrace(trace);
}

export async function loadExecutionTrace(executionId: string): Promise<ExecutionTrace | null> {
  const storage = new ExecutionTraceStorage();
  return storage.loadTrace(executionId);
}

// Re-export types
export type { MemoryEntry, MemoryQuery, MemoryEntryType };
