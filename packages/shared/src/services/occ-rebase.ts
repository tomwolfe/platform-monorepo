/**
 * Optimistic Concurrency Control with Automated Rebase
 *
 * Problem Solved: Ghost Update Race Condition
 * - High-concurrency environments (user follow-ups + QStash retries) create
 *   Read-Modify-Write race conditions between lambda memory and Redis
 * - Simple OCC detects conflicts but doesn't resolve them
 *
 * Solution: Automated Rebase Pattern
 * - On CONFLICT: reload state, apply delta, retry write
 * - Uses Lua script for atomic compare-and-swap
 * - Exponential backoff for retry storms
 *
 * Usage:
 * ```typescript
 * const rebase = createAtomicStateRebaser('task:execution-123');
 * 
 * const result = await rebase.update(
 *   (currentState) => ({
 *     ...currentState,
 *     status: 'COMPLETED',
 *     step_states: [...currentState.step_states, newStep]
 *   }),
 *   { maxRetries: 3 }
 * );
 * 
 * if (result.success) {
 *   console.log('State updated atomically');
 * } else {
 *   console.log('Update failed after rebase attempts');
 * }
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { Redis } from "@upstash/redis";
import { getRedisClient, ServiceNamespace } from "../redis";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface AtomicUpdateResult<T> {
  /** Whether the update was successful */
  success: boolean;
  /** The updated state (if successful) */
  updatedState?: T;
  /** The state that was overwritten by another writer (if conflict) */
  overwrittenState?: T;
  /** Number of rebase attempts */
  rebaseAttempts: number;
  /** Error message (if failed) */
  error?: string;
  /** Whether the final attempt succeeded via rebase */
  succeededViaRebase: boolean;
}

export interface AtomicUpdateOptions {
  /** Maximum number of rebase attempts (default: 3) */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default: 100) */
  baseDelayMs?: number;
  /** Maximum delay for exponential backoff in ms (default: 1000) */
  maxDelayMs?: number;
  /** Enable debug logging */
  debug?: boolean;
  /** Custom conflict handler (if not provided, uses automatic rebase) */
  onConflict?: (currentState: any, expectedState: any) => Promise<any>;
}

const DEFAULT_OPTIONS: AtomicUpdateOptions = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 1000,
  debug: false,
};

// ============================================================================
// LUA SCRIPT FOR ATOMIC COMPARE-AND-SWAP
// ============================================================================

/**
 * Lua script for atomic compare-and-swap operation
 * 
 * KEYS[1] = state key
 * ARGV[1] = expected version (or "any" for first write)
 * ARGV[2] = new state JSON
 * ARGV[3] = new version
 * 
 * Returns: { success: 0|1, currentVersion: number, currentState: string }
 */
const ATOMIC_CAS_SCRIPT = `
local key = KEYS[1]
local expectedVersion = ARGV[1]
local newState = ARGV[2]
local newVersion = tonumber(ARGV[3])

-- Get current state
local current = redis.call('GET', key)
local currentVersion = 0
local currentState = nil

if current then
  local decoded = cjson.decode(current)
  currentVersion = decoded._version or 0
  currentState = current
end

-- Check version match
if expectedVersion ~= "any" and tostring(currentVersion) ~= expectedVersion then
  -- Conflict detected
  return { 0, currentVersion, currentState or "null" }
end

-- Perform update
redis.call('SET', key, newState)
return { 1, newVersion, newState }
`;

/**
 * Lua script for atomic state update with delta application
 * 
 * This script applies a delta to the current state atomically
 * 
 * KEYS[1] = state key
 * ARGV[1] = delta JSON (partial state update)
 * ARGV[2] = new version
 * 
 * Returns: { success: 1, version: number, state: string }
 */
const ATOMIC_DELTA_SCRIPT = `
local key = KEYS[1]
local deltaJson = ARGV[1]
local newVersion = tonumber(ARGV[2])

-- Get current state
local current = redis.call('GET', key)
if not current then
  return { 0, 0, "null" }
end

local currentState = cjson.decode(current)
local delta = cjson.decode(deltaJson)

-- Apply delta (shallow merge)
for k, v in pairs(delta) do
  currentState[k] = v
end

-- Update version
currentState._version = newVersion

-- Save updated state
local newState = cjson.encode(currentState)
redis.call('SET', key, newState)

return { 1, newVersion, newState }
`;

// ============================================================================
// ATOMIC STATE REBASER
// ============================================================================

export class AtomicStateRebaser<T extends { _version?: number }> {
  private key: string;
  private debug: boolean;
  private redis: Redis;

  constructor(key: string, debug: boolean = false, redis?: Redis) {
    this.key = key;
    this.debug = debug;
    this.redis = redis || getRedisClient(ServiceNamespace.SHARED);
  }

  /**
   * Load current state from Redis
   */
  private async loadState(): Promise<T | null> {
    const data = await this.redis.get<string>(this.key);
    if (!data) return null;
    return JSON.parse(data) as T;
  }

  /**
   * Calculate exponential backoff delay
   */
  private calculateBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
    const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * 0.3 * exponentialDelay; // Add 30% jitter
    return Math.min(exponentialDelay + jitter, maxDelayMs);
  }

  /**
   * Update state atomically with automatic rebase on conflict
   *
   * @param updateFn - Function that takes current state and returns updated state
   * @param options - Update options
   * @returns Result of the atomic update
   */
  async update(
    updateFn: (currentState: T) => Partial<T>,
    options: AtomicUpdateOptions = {}
  ): Promise<AtomicUpdateResult<T>> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    let rebaseAttempts = 0;
    let lastError: string | undefined;

    while (rebaseAttempts <= opts.maxRetries!) {
      try {
        // Load current state
        const currentState = await this.loadState();
        
        if (!currentState) {
          return {
            success: false,
            rebaseAttempts,
            error: "State does not exist",
            succeededViaRebase: false,
          };
        }

        const currentVersion = currentState._version || 0;

        // Apply update function
        const updates = updateFn(currentState);
        const newState: T = {
          ...currentState,
          ...updates,
          _version: currentVersion + 1,
        };

        // Attempt atomic compare-and-swap
        const result = await this.atomicCas(currentVersion, newState);

        if (result.success) {
          return {
            success: true,
            updatedState: newState,
            rebaseAttempts,
            succeededViaRebase: rebaseAttempts > 0,
          };
        }

        // Conflict detected
        if (opts.debug) {
          console.log(
            `[AtomicStateRebaser] Conflict detected for ${this.key} ` +
            `(expected version ${currentVersion}, got ${result.currentVersion})`
          );
        }

        rebaseAttempts++;

        if (rebaseAttempts > opts.maxRetries!) {
          return {
            success: false,
            overwrittenState: result.overwrittenState,
            rebaseAttempts,
            error: `Max rebase attempts exceeded (${opts.maxRetries})`,
            succeededViaRebase: false,
          };
        }

        // Exponential backoff before retry
        const delay = this.calculateBackoff(
          rebaseAttempts,
          opts.baseDelayMs!,
          opts.maxDelayMs!
        );
        
        if (opts.debug) {
          console.log(
            `[AtomicStateRebaser] Backing off for ${delay.toFixed(0)}ms ` +
            `before rebase attempt ${rebaseAttempts}/${opts.maxRetries}`
          );
        }
        
        await this.sleep(delay);

      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        
        if (opts.debug) {
          console.error(`[AtomicStateRebaser] Error during update:`, error);
        }

        rebaseAttempts++;
        
        if (rebaseAttempts > opts.maxRetries!) {
          return {
            success: false,
            rebaseAttempts,
            error: lastError,
            succeededViaRebase: false,
          };
        }

        // Backoff before retry on error
        const delay = this.calculateBackoff(
          rebaseAttempts,
          opts.baseDelayMs!,
          opts.maxDelayMs!
        );
        await this.sleep(delay);
      }
    }

    return {
      success: false,
      rebaseAttempts,
      error: lastError || "Unknown error",
      succeededViaRebase: false,
    };
  }

  /**
   * Atomic compare-and-swap operation
   */
  private async atomicCas(
    expectedVersion: number,
    newState: T
  ): Promise<{
    success: boolean;
    currentVersion: number;
    overwrittenState?: T;
  }> {
    const newVersion = (newState._version || 0);

    try {
      const result = await this.redis.eval(
        ATOMIC_CAS_SCRIPT,
        [this.key],
        [
          expectedVersion.toString(),
          JSON.stringify(newState),
          newVersion.toString(),
        ]
      );

      const [success, version, stateJson] = result as [number, number, string];

      if (success === 1) {
        return {
          success: true,
          currentVersion: version,
        };
      }

      // Conflict - state was modified by another writer
      const overwrittenState = stateJson !== "null" ? JSON.parse(stateJson) as T : undefined;

      return {
        success: false,
        currentVersion: version,
        overwrittenState,
      };
    } catch (error) {
      console.error(`[AtomicStateRebaser] CAS failed:`, error);
      throw error;
    }
  }

  /**
   * Apply delta update atomically
   *
   * This is more efficient than full state replacement for simple updates
   */
  async applyDelta(
    delta: Partial<Omit<T, "_version">>,
    options: AtomicUpdateOptions = {}
  ): Promise<AtomicUpdateResult<T>> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    let rebaseAttempts = 0;

    while (rebaseAttempts <= opts.maxRetries!) {
      try {
        // Load current state
        const currentState = await this.loadState();
        
        if (!currentState) {
          return {
            success: false,
            rebaseAttempts,
            error: "State does not exist",
            succeededViaRebase: false,
          };
        }

        const currentVersion = currentState._version || 0;
        const newVersion = currentVersion + 1;

        // Apply delta atomically via Lua script
        const result = await this.redis.eval(
          ATOMIC_DELTA_SCRIPT,
          [this.key],
          [
            JSON.stringify(delta),
            newVersion.toString(),
          ]
        );

        const [success, version, stateJson] = result as [number, number, string];

        if (success === 1) {
          return {
            success: true,
            updatedState: JSON.parse(stateJson) as T,
            rebaseAttempts,
            succeededViaRebase: rebaseAttempts > 0,
          };
        }

        rebaseAttempts++;

        if (rebaseAttempts > opts.maxRetries!) {
          return {
            success: false,
            rebaseAttempts,
            error: `Max rebase attempts exceeded (${opts.maxRetries})`,
            succeededViaRebase: false,
          };
        }

        // Backoff before retry
        const delay = this.calculateBackoff(
          rebaseAttempts,
          opts.baseDelayMs!,
          opts.maxDelayMs!
        );
        await this.sleep(delay);

      } catch (error) {
        if (opts.debug) {
          console.error(`[AtomicStateRebaser] Delta update failed:`, error);
        }

        rebaseAttempts++;
        
        if (rebaseAttempts > opts.maxRetries!) {
          return {
            success: false,
            rebaseAttempts,
            error: error instanceof Error ? error.message : String(error),
            succeededViaRebase: false,
          };
        }

        const delay = this.calculateBackoff(
          rebaseAttempts,
          opts.baseDelayMs!,
          opts.maxDelayMs!
        );
        await this.sleep(delay);
      }
    }

    return {
      success: false,
      rebaseAttempts,
      error: "Max rebase attempts exceeded",
      succeededViaRebase: false,
    };
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

/**
 * Create an atomic state rebaser for a key
 */
export function createAtomicStateRebaser<T extends { _version?: number }>(
  key: string,
  debug?: boolean,
  redis?: Redis
): AtomicStateRebaser<T> {
  return new AtomicStateRebaser<T>(key, debug, redis);
}

/**
 * Update state atomically with automatic rebase
 *
 * Convenience function for one-off updates
 */
export async function atomicUpdateState<T extends { _version?: number }>(
  key: string,
  updateFn: (currentState: T) => Partial<T>,
  options?: AtomicUpdateOptions & { redis?: Redis }
): Promise<AtomicUpdateResult<T>> {
  const rebaser = createAtomicStateRebaser<T>(key, options?.debug, options?.redis);
  return rebaser.update(updateFn, options);
}

// ============================================================================
// WORKFLOW-SPECIFIC HELPERS
// Integration with WorkflowMachine execution states
// ============================================================================

/**
 * Build Redis key for execution state
 */
export function buildExecutionStateKey(executionId: string): string {
  return `intentionengine:task:${executionId}`;
}

/**
 * Create atomic rebaser for workflow execution state
 */
export function createWorkflowStateRebaser(
  executionId: string,
  debug?: boolean
): AtomicStateRebaser<any> {
  const key = buildExecutionStateKey(executionId);
  return createAtomicStateRebaser(key, debug);
}

// ============================================================================
// END OF FILE
// ============================================================================
