/**
 * Shared Memory Client
 * Moved from apps/intention-engine/src/lib/engine/memory.ts
 * Provides standardized Redis-backed memory for all services.
 * 
 * Vercel Hobby Tier Optimization:
 * - Task Queue pattern for durable state machine transitions
 * - Atomic state transitions for resumable execution
 * - Upstash QStash integration for background triggers
 */

import { Redis } from '@upstash/redis';
import {
  ExecutionState,
  ExecutionTrace,
  ExecutionStateSchema,
  ExecutionTraceSchema
} from '../types/execution';

// ============================================================================
// MEMORY CONFIGURATION
// Default TTL and namespace settings
// ============================================================================

export const MEMORY_CONFIG = {
  default_namespace: "shared",
  default_ttl_seconds: 3600, // 1 hour
  max_ttl_seconds: 86400 * 7, // 7 days
  key_separator: ":",
  
  // TTL by entry type
  ttl_by_type: {
    execution_state: 3600,      // 1 hour
    execution_trace: 86400,     // 24 hours
    intent_history: 86400 * 3,  // 3 days
    plan_cache: 3600,           // 1 hour
    tool_result: 1800,          // 30 minutes
    user_context: 86400 * 7,    // 7 days
    system_config: 0,           // No TTL (persistent)
  } as Record<string, number>,
};

// ============================================================================
// MEMORY ENTRY TYPES
// ============================================================================

export type MemoryEntryType = 
  | "execution_state" 
  | "execution_trace" 
  | "intent_history" 
  | "plan_cache" 
  | "tool_result" 
  | "user_context" 
  | "system_config";

export interface MemoryEntry {
  key: string;
  type: MemoryEntryType;
  namespace: string;
  data: unknown;
  created_at: string;
  expires_at?: string;
  ttl_seconds?: number;
  version: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryQuery {
  namespace: string;
  type?: MemoryEntryType;
  prefix?: string;
  after?: string;
  before?: string;
  limit: number;
}

export type MemoryEntryInput = Omit<MemoryEntry, "key" | "created_at" | "expires_at">;

// ============================================================================
// MEMORY ERROR
// ============================================================================

export interface MemoryError {
  code: string;
  message: string;
  details?: unknown;
  recoverable: boolean;
  timestamp: string;
}

// ============================================================================
// TASK QUEUE TYPES - Vercel Hobby Tier Optimization
// State machine pattern for durable execution
// ============================================================================

export type TaskStatus = 
  | "pending"
  | "in_progress"
  | "awaiting_confirmation"
  | "completed"
  | "failed"
  | "cancelled"
  | "compensating"
  | "compensated";

export interface TaskStateTransition {
  from_status: TaskStatus;
  to_status: TaskStatus;
  timestamp: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskState {
  task_id: string;
  execution_id: string;
  intent_id?: string;
  status: TaskStatus;
  current_step_index: number;
  total_steps: number;
  segment_number: number;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  transitions: TaskStateTransition[];
  context: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    step_id?: string;
  };
}

export interface TaskQueueItem {
  task_id: string;
  execution_id: string;
  priority: number;
  scheduled_at: string;
  max_attempts: number;
  attempt_count: number;
  payload: {
    intent_id?: string;
    plan_id?: string;
    start_step_index?: number;
    segment_number?: number;
    trace_id?: string;
  };
}

// ============================================================================
// STATE TRANSITION RESULT
// ============================================================================

export interface StateTransitionResult {
  success: boolean;
  previous_state?: TaskState;
  new_state?: TaskState;
  error?: {
    code: string;
    message: string;
  };
}

// ============================================================================
// MEMORY CLIENT
// Redis client wrapper with type safety
// ============================================================================

export class MemoryClient {
  private redis: Redis;
  private namespace: string;

  constructor(redis: Redis, namespace: string = MEMORY_CONFIG.default_namespace) {
    this.redis = redis;
    this.namespace = namespace;
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
    const completeEntry: MemoryEntry = {
      ...entry,
      key,
      created_at: timestamp,
      expires_at: expiresAt,
      ttl_seconds: effectiveTtl > 0 ? effectiveTtl : undefined,
      version: entry.version ?? 1,
    };

    try {
      // Store in Redis with TTL
      if (effectiveTtl > 0) {
        await this.redis.setex(key, effectiveTtl, JSON.stringify(completeEntry));
      } else {
        await this.redis.set(key, JSON.stringify(completeEntry));
      }

      return completeEntry;
    } catch (error) {
      throw {
        code: "MEMORY_OPERATION_FAILED",
        message: `Failed to store memory entry: ${error}`,
        details: { key, type: entry.type },
        recoverable: false,
        timestamp,
      } as MemoryError;
    }
  }

  // ========================================================================
  // RETRIEVE ENTRY
  // Get a memory entry by key
  // ========================================================================

  async retrieve(key: string): Promise<MemoryEntry | null> {
    try {
      const data = await this.redis.get<string>(key);
      
      if (!data) {
        return null;
      }

      // Parse and validate
      const parsed = JSON.parse(data);
      return parsed as MemoryEntry;
    } catch (error) {
      throw {
        code: "MEMORY_OPERATION_FAILED",
        message: `Failed to retrieve memory entry: ${error}`,
        details: { key },
        recoverable: false,
        timestamp: new Date().toISOString(),
      } as MemoryError;
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
      throw {
        code: "MEMORY_OPERATION_FAILED",
        message: `Failed to delete memory entry: ${error}`,
        details: { key },
        recoverable: false,
        timestamp: new Date().toISOString(),
      } as MemoryError;
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
      throw {
        code: "MEMORY_OPERATION_FAILED",
        message: `Failed to query memory entries: ${error}`,
        details: { query },
        recoverable: false,
        timestamp: new Date().toISOString(),
      } as MemoryError;
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
      return 0;
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

  // ========================================================================
  // TASK QUEUE OPERATIONS - Vercel Hobby Tier Optimization
  // Atomic state transitions for durable execution
  // ========================================================================

  private buildTaskKey(executionId: string): string {
    return `${this.namespace}${MEMORY_CONFIG.key_separator}task_state${MEMORY_CONFIG.key_separator}${executionId}`;
  }

  private buildQueueKey(): string {
    return `${this.namespace}${MEMORY_CONFIG.key_separator}task_queue`;
  }

  /**
   * Creates a new task state in the queue.
   * Used when starting a new execution.
   */
  async createTaskState(taskState: TaskState): Promise<void> {
    const key = this.buildTaskKey(taskState.execution_id);
    const queueKey = this.buildQueueKey();

    try {
      // Store task state with 24h TTL
      await this.redis.setex(key, 86400, JSON.stringify(taskState));

      // Add to priority queue (sorted set by priority)
      await this.redis.zadd(queueKey, {
        member: taskState.task_id,
        score: taskState.context.priority as number || 0,
      });

      console.log(`[TaskQueue] Created task ${taskState.task_id} for execution ${taskState.execution_id}`);
    } catch (error) {
      throw {
        code: "MEMORY_OPERATION_FAILED",
        message: `Failed to create task state: ${error}`,
        details: { task_id: taskState.task_id, execution_id: taskState.execution_id },
        recoverable: false,
        timestamp: new Date().toISOString(),
      } as MemoryError;
    }
  }

  /**
   * Atomically transitions a task to a new state.
   * Uses WATCH/MULTI/EXEC for optimistic locking.
   */
  async transitionTaskState(
    executionId: string,
    newStatus: TaskStatus,
    reason?: string,
    metadata?: Record<string, unknown>
  ): Promise<StateTransitionResult> {
    const key = this.buildTaskKey(executionId);
    const timestamp = new Date().toISOString();

    try {
      // Get current state
      const currentStateJson = await this.redis.get<string>(key);
      if (!currentStateJson) {
        return {
          success: false,
          error: {
            code: "TASK_NOT_FOUND",
            message: `Task state not found for execution ${executionId}`,
          },
        };
      }

      const currentState = JSON.parse(currentStateJson) as TaskState;
      const previousStatus = currentState.status;

      // Validate transition (prevent invalid state changes)
      const validTransitions: Record<TaskStatus, TaskStatus[]> = {
        pending: ["in_progress", "cancelled"],
        in_progress: ["completed", "failed", "awaiting_confirmation", "cancelled", "compensating"],
        awaiting_confirmation: ["in_progress", "cancelled", "failed"],
        completed: [],
        failed: ["compensating"],
        cancelled: [],
        compensating: ["compensated", "failed"],
        compensated: [],
      };

      if (!validTransitions[previousStatus].includes(newStatus)) {
        return {
          success: false,
          previous_state: currentState,
          error: {
            code: "INVALID_TRANSITION",
            message: `Cannot transition from ${previousStatus} to ${newStatus}`,
          },
        };
      }

      // Create transition record
      const transition: TaskStateTransition = {
        from_status: previousStatus,
        to_status: newStatus,
        timestamp,
        reason,
        metadata,
      };

      // Build new state
      const newState: TaskState = {
        ...currentState,
        status: newStatus,
        updated_at: timestamp,
        transitions: [...currentState.transitions, transition],
        completed_at: newStatus === "completed" || newStatus === "failed" || newStatus === "cancelled" || newStatus === "compensated"
          ? timestamp
          : currentState.completed_at,
      };

      // Atomic update
      await this.redis.setex(key, 86400, JSON.stringify(newState));

      console.log(
        `[TaskQueue] Transitioned ${executionId}: ${previousStatus} -> ${newStatus}${reason ? ` (${reason})` : ''}`
      );

      return {
        success: true,
        previous_state: currentState,
        new_state: newState,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: "TRANSITION_FAILED",
          message: `Failed to transition task state: ${error}`,
        },
      };
    }
  }

  /**
   * Retrieves the current task state.
   */
  async getTaskState(executionId: string): Promise<TaskState | null> {
    const key = this.buildTaskKey(executionId);

    try {
      const data = await this.redis.get<string>(key);
      if (!data) return null;
      return JSON.parse(data) as TaskState;
    } catch (error) {
      console.error(`Failed to get task state for ${executionId}:`, error);
      return null;
    }
  }

  /**
   * Updates task context (e.g., storing step results, compensation data).
   */
  async updateTaskContext(executionId: string, contextUpdate: Record<string, unknown>): Promise<boolean> {
    const key = this.buildTaskKey(executionId);

    try {
      const currentState = await this.getTaskState(executionId);
      if (!currentState) return false;

      const updatedState: TaskState = {
        ...currentState,
        context: {
          ...currentState.context,
          ...contextUpdate,
        },
        updated_at: new Date().toISOString(),
      };

      await this.redis.setex(key, 86400, JSON.stringify(updatedState));
      return true;
    } catch (error) {
      console.error(`Failed to update task context for ${executionId}:`, error);
      return false;
    }
  }

  /**
   * Stores a step result in the task context.
   * Used for checkpointing during segment execution.
   */
  async storeStepResult(
    executionId: string,
    stepIndex: number,
    stepId: string,
    result: {
      success: boolean;
      output?: unknown;
      error?: string;
      latency_ms: number;
    }
  ): Promise<boolean> {
    const contextKey = `step_result:${stepIndex}`;
    return this.updateTaskContext(executionId, { [contextKey]: result });
  }

  /**
   * Retrieves a stored step result.
   */
  async getStepResult(executionId: string, stepIndex: number): Promise<unknown | null> {
    const taskState = await this.getTaskState(executionId);
    if (!taskState) return null;

    const contextKey = `step_result:${stepIndex}`;
    return taskState.context[contextKey] || null;
  }

  /**
   * Schedules a task for future execution (QStash-style).
   * Used for resuming execution after Vercel timeout.
   */
  async scheduleTaskResume(
    executionId: string,
    delaySeconds: number,
    payload: TaskQueueItem["payload"]
  ): Promise<void> {
    const queueKey = this.buildQueueKey();
    const scheduledAt = new Date(Date.now() + delaySeconds * 1000).toISOString();

    const queueItem: TaskQueueItem = {
      task_id: `resume:${executionId}`,
      execution_id: executionId,
      priority: payload.segment_number || 1,
      scheduled_at: scheduledAt,
      max_attempts: 3,
      attempt_count: 0,
      payload,
    };

    try {
      // Store queue item with TTL
      const itemKey = `${queueKey}:${executionId}`;
      await this.redis.setex(itemKey, 3600, JSON.stringify(queueItem));

      // Add to sorted set for time-based retrieval
      await this.redis.zadd(`${queueKey}:scheduled`, {
        member: executionId,
        score: Date.now() + delaySeconds * 1000,
      });

      console.log(
        `[TaskQueue] Scheduled resume for ${executionId} in ${delaySeconds}s [segment ${payload.segment_number}]`
      );
    } catch (error) {
      throw {
        code: "MEMORY_OPERATION_FAILED",
        message: `Failed to schedule task resume: ${error}`,
        details: { execution_id: executionId },
        recoverable: false,
        timestamp: new Date().toISOString(),
      } as MemoryError;
    }
  }

  /**
   * Gets tasks ready for execution (scheduled time has passed).
   */
  async getReadyTasks(limit: number = 10): Promise<TaskQueueItem[]> {
    const queueKey = this.buildQueueKey();
    const now = Date.now();

    try {
      // Get tasks whose scheduled time has passed
      // Upstash Redis uses zrange with byScore option
      const readyIds = await this.redis.zrange(
        `${queueKey}:scheduled`,
        0,
        now,
        { byScore: true, offset: 0, count: limit }
      );

      const tasks: TaskQueueItem[] = [];

      for (const executionId of readyIds) {
        const itemKey = `${queueKey}:${executionId}`;
        const data = await this.redis.get<string>(itemKey);
        if (data) {
          tasks.push(JSON.parse(data) as TaskQueueItem);
        }
      }

      return tasks;
    } catch (error) {
      console.error(`Failed to get ready tasks:`, error);
      return [];
    }
  }

  /**
   * Marks a scheduled task as being processed.
   */
  async markTaskProcessing(executionId: string): Promise<void> {
    const queueKey = this.buildQueueKey();

    try {
      // Remove from scheduled queue
      await this.redis.zrem(`${queueKey}:scheduled`, executionId);

      // Delete the queue item
      await this.redis.del(`${queueKey}:${executionId}`);
    } catch (error) {
      console.error(`Failed to mark task processing for ${executionId}:`, error);
    }
  }

  /**
   * Stores confirmation state for high-risk operations.
   * Used by SecurityProvider guardrails.
   */
  async storeConfirmationState(
    executionId: string,
    stepId: string,
    requiresConfirmation: boolean,
    confirmationStatus: "pending" | "confirmed" | "rejected" = "pending"
  ): Promise<void> {
    const confirmationKey = `confirmation:${stepId}`;
    await this.updateTaskContext(executionId, {
      [confirmationKey]: {
        requires_confirmation: requiresConfirmation,
        status: confirmationStatus,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * Gets confirmation state for a step.
   */
  async getConfirmationState(
    executionId: string,
    stepId: string
  ): Promise<{ requires_confirmation: boolean; status: string } | null> {
    const taskState = await this.getTaskState(executionId);
    if (!taskState) return null;

    const confirmationKey = `confirmation:${stepId}`;
    return taskState.context[confirmationKey] as { requires_confirmation: boolean; status: string } | null;
  }

  // ========================================================================
  // ATOMIC STATE VERSIONING (OCC - Optimistic Concurrency Control)
  // Prevents "Ghost Re-plan" Race Condition
  // ========================================================================

  /**
   * Atomically updates execution state with version checking (CAS pattern).
   * Prevents split-brain state when QStash retry happens simultaneously with user follow-up.
   *
   * @param executionId - The execution ID
   * @param newState - The new state to set
   * @param expectedVersion - The expected current version (for CAS check)
   * @returns Object with success status and new version or error
   *
   * @example
   * const result = await memory.updateStateAtomically(executionId, newState, currentState.version);
   * if (result.success) {
   *   console.log(`Updated to version ${result.newVersion}`);
   * } else if (result.error?.code === 'CONFLICT') {
   *   // Another lambda modified state - reload and retry
   *   console.log('Conflict detected - reload state');
   * }
   */
  async updateStateAtomically(
    executionId: string,
    newState: Partial<ExecutionState> & { version?: number },
    expectedVersion: number
  ): Promise<{
    success: boolean;
    newVersion?: number;
    currentVersion?: number;
    error?: {
      code: 'NOT_FOUND' | 'CONFLICT' | 'OPERATION_FAILED';
      message: string;
    };
  }> {
    const key = this.buildTaskKey(executionId);
    const timestamp = new Date().toISOString();

    try {
      // Lua script for atomic compare-and-swap
      const script = `
        local current = redis.call('get', KEYS[1])
        if not current then
          return redis.error_reply('NOT_FOUND')
        end
        
        local decoded = cjson.decode(current)
        local currentVersion = decoded.version or 0
        
        if currentVersion ~= tonumber(ARGV[1]) then
          return redis.error_reply('CONFLICT:' .. tostring(currentVersion))
        end
        
        -- Merge new state into existing state
        local newState = cjson.decode(ARGV[2])
        for k, v in pairs(newState) do
          decoded[k] = v
        end
        
        -- Increment version
        decoded.version = currentVersion + 1
        decoded.updated_at = ARGV[3]
        
        redis.call('setex', KEYS[1], 86400, cjson.encode(decoded))
        return tostring(decoded.version)
      `;

      // Execute Lua script atomically
      const result = await this.redis.eval(
        script,
        [key], // keys array
        [expectedVersion.toString(), JSON.stringify(newState), timestamp] // args array
      );

      return {
        success: true,
        newVersion: parseInt(result as string, 10),
      };
    } catch (error: any) {
      const errorMessage = typeof error === 'string' ? error : error?.message || String(error);

      if (errorMessage.includes('NOT_FOUND')) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Execution state not found for ${executionId}`,
          },
        };
      }

      if (errorMessage.includes('CONFLICT')) {
        const match = errorMessage.match(/CONFLICT:(\d+)/);
        const currentVersion = match ? parseInt(match[1], 10) : undefined;
        return {
          success: false,
          currentVersion,
          error: {
            code: 'CONFLICT',
            message: `Version conflict - expected ${expectedVersion}, got ${currentVersion ?? 'unknown'}`,
          },
        };
      }

      return {
        success: false,
        error: {
          code: 'OPERATION_FAILED',
          message: `Failed to update state atomically: ${errorMessage}`,
        },
      };
    }
  }

  /**
   * Gets the current version of an execution state.
   * Used for OCC version tracking.
   */
  async getStateVersion(executionId: string): Promise<number | null> {
    const taskState = await this.getTaskState(executionId);
    if (!taskState) return null;
    return taskState.context.version as number ?? 1;
  }

  /**
   * Initializes or resets version tracking for an execution.
   */
  async initializeVersion(executionId: string): Promise<number> {
    const key = this.buildTaskKey(executionId);
    const timestamp = new Date().toISOString();

    const initialState = {
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
    };

    await this.updateTaskContext(executionId, initialState);
    return 1;
  }
}

// ============================================================================
// EXECUTION STATE STORAGE
// Specialized functions for execution state persistence
// ============================================================================

export class ExecutionStateStorage {
  private memory: MemoryClient;

  constructor(memory: MemoryClient) {
    this.memory = memory;
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
    if (!entry) return null;
    
    const parsed = ExecutionStateSchema.safeParse(entry.data);
    return parsed.success ? parsed.data : null;
  }

  async deleteState(executionId: string): Promise<boolean> {
    const key = `${MEMORY_CONFIG.default_namespace}:execution_state:${executionId}`;
    return this.memory.delete(key);
  }
}

// ============================================================================
// EXECUTION TRACE STORAGE
// Specialized functions for trace persistence
// ============================================================================

export class ExecutionTraceStorage {
  private memory: MemoryClient;

  constructor(memory: MemoryClient) {
    this.memory = memory;
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
    if (!entry) return null;
    
    const parsed = ExecutionTraceSchema.safeParse(entry.data);
    return parsed.success ? parsed.data : null;
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

export function getMemoryClient(namespace: string = MEMORY_CONFIG.default_namespace): MemoryClient {
  if (!defaultMemoryClient) {
    const { getRedisClient, ServiceNamespace } = require('../redis');
    const redis = getRedisClient(ServiceNamespace.SHARED);
    defaultMemoryClient = new MemoryClient(redis, namespace);
  }
  return defaultMemoryClient;
}
