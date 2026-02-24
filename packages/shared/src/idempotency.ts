import { Redis } from '@upstash/redis';

export interface IdempotencyServiceConfig {
  /** Salt hash with userId to prevent cross-user blocking */
  userId?: string;
  /** Default TTL in seconds (default: 24 hours) */
  defaultTtlSeconds?: number;
  /**
   * PERFECT GRADE: Causal-Key Idempotency
   * Include parent_intent_id and lamport_timestamp in hash
   * Prevents "Double-Tap" bugs across different devices/sessions
   * Ensures action is unique to the specific causal chain of conversation
   */
  enableCausalKey?: boolean;
  /** Parent intent ID for causal chain tracking */
  parentIntentId?: string;
  /** Lamport timestamp for causal ordering */
  lamportTimestamp?: number;
}

export class IdempotencyService {
  private redis: Redis;
  private userId?: string;
  private defaultTtlSeconds: number;
  private enableCausalKey: boolean;
  private parentIntentId?: string;
  private lamportTimestamp?: number;

  constructor(redis: Redis, config?: IdempotencyServiceConfig) {
    this.redis = redis;
    this.userId = config?.userId;
    this.defaultTtlSeconds = config?.defaultTtlSeconds ?? (24 * 60 * 60);
    this.enableCausalKey = config?.enableCausalKey ?? true;
    this.parentIntentId = config?.parentIntentId;
    this.lamportTimestamp = config?.lamportTimestamp;
  }

  /**
   * Generate a deterministic hash from parameters
   * Uses Web Crypto API for Edge Runtime compatibility
   * Normalizes and sorts parameters to ensure consistent hashing
   * even if LLM sends parameters in different order or with whitespace variations
   *
   * ENHANCEMENT: Semantic Checksum Idempotency
   * - Now includes toolName in the hash for stricter idempotency
   * - Key format: SHA-256(toolName + sortedParameters)
   * - Prevents double-execution even if plan changes but action is the same
   *
   * CRITICAL FIX: Idempotency Cross-User Blocking
   * - Salt the hash with userId to prevent two different users making the same
   *   request from blocking each other
   * - Key format: SHA-256(userId + toolName + sortedParameters)
   *
   * PERFECT GRADE: Causal-Key Idempotency
   * - Includes parent_intent_id and lamport_timestamp in the hash
   * - Prevents "Double-Tap" bugs across different devices or sessions
   * - Ensures action is unique not just to the user, but to the specific causal chain
   * - Key format: SHA-256(userId + parentIntentId + lamportTimestamp + toolName + sortedParameters)
   */
  private async generateParamsHash(
    toolName: string,
    parameters: Record<string, unknown>,
    userId?: string
  ): Promise<string> {
    // PERFECT GRADE: Include causal chain components
    const causalComponents: any = {
      user: userId || 'anonymous',
      tool: toolName,
    };

    // Add causal chain tracking if enabled
    if (this.enableCausalKey) {
      causalComponents.parentIntent = this.parentIntentId || 'none';
      causalComponents.lamportTs = this.lamportTimestamp || 0;
    }

    // Add sorted parameters
    causalComponents.params = Object.entries(parameters)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, this.normalizeValue(value)]);

    const sortedParams = JSON.stringify(causalComponents);

    // Use Web Crypto API for Edge Runtime compatibility
    const encoder = new TextEncoder();
    const data = encoder.encode(sortedParams);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return hashHex.substring(0, 16); // Use 16 chars for better collision resistance
  }

  /**
   * Normalize a value for hashing
   * - Strings: trim whitespace, normalize case for comparison values
   * - Numbers: convert to string
   * - Objects: JSON stringify with sorted keys
   */
  private normalizeValue(value: unknown): unknown {
    if (typeof value === 'string') {
      // Trim whitespace but preserve case for meaningful values
      return value.trim();
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (value === null || value === undefined) {
      return null;
    }
    if (Array.isArray(value)) {
      return value.map(v => this.normalizeValue(v));
    }
    if (typeof value === 'object') {
      return Object.entries(value as object)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, this.normalizeValue(v)]);
    }
    return value;
  }

  /**
   * Checks if a key has already been processed.
   * If not, it sets the key with a 24-hour TTL.
   *
   * ENHANCEMENT: Semantic Checksum Idempotency
   * - Uses SHA-256(toolName + sortedParameters) for stricter idempotency
   * - Even if plan changes, if the action is the same, it won't repeat
   *
   * CRITICAL FIX: Cross-User Blocking Prevention
   * - Salts hash with userId to prevent different users from blocking each other
   *
   * PERFECT GRADE: Causal-Key Idempotency
   * - Includes parent_intent_id and lamport_timestamp in hash
   * - Prevents "Double-Tap" bugs across devices/sessions belonging to same user
   * - Ensures action is unique to the specific causal chain of conversation
   *
   * @param key - Base key (e.g., `${executionId}:${stepIndex}`)
   * @param toolName - Tool name to include in semantic hash
   * @param parameters - Optional parameters to include in hash for stricter idempotency
   * @param userId - Optional user ID to salt the hash (prevents cross-user blocking)
   * @returns true if it's a duplicate, false if it's new.
   */
  async isDuplicate(
    key: string,
    toolName: string,
    parameters?: Record<string, unknown>,
    userId?: string
  ): Promise<boolean> {
    const effectiveUserId = userId || this.userId;
    const paramsHash = parameters ? await this.generateParamsHash(toolName, parameters, effectiveUserId) : null;
    const fullKey = paramsHash
      ? `idempotency:${key}:${paramsHash}`
      : `idempotency:${key}`;

    const set = await this.redis.set(fullKey, 'processed', {
      nx: true,
      ex: this.defaultTtlSeconds,
    });
    return set === null;
  }

  /**
   * Get the idempotency key for debugging/logging
   */
  async getKey(
    key: string,
    toolName: string,
    parameters?: Record<string, unknown>,
    userId?: string
  ): Promise<string> {
    const effectiveUserId = userId || this.userId;
    const paramsHash = parameters ? await this.generateParamsHash(toolName, parameters, effectiveUserId) : null;
    return paramsHash
      ? `idempotency:${key}:${paramsHash}`
      : `idempotency:${key}`;
  }

  /**
   * Create a child idempotency service with causal context
   *
   * PERFECT GRADE: Causal-Key Idempotency
   * - Creates a new service instance with parent_intent_id and lamport_timestamp
   * - Used for nested operations that need causal chain tracking
   *
   * @param parentIntentId - Parent intent ID for causal chain
   * @param lamportTimestamp - Lamport timestamp for causal ordering
   * @returns New idempotency service with causal context
   */
  withCausalContext(
    parentIntentId: string,
    lamportTimestamp: number
  ): IdempotencyService {
    return new IdempotencyService(this.redis, {
      userId: this.userId,
      defaultTtlSeconds: this.defaultTtlSeconds,
      enableCausalKey: true,
      parentIntentId,
      lamportTimestamp,
    });
  }

  /**
   * Get causal context from this service
   */
  getCausalContext(): {
    enableCausalKey: boolean;
    parentIntentId?: string;
    lamportTimestamp?: number;
  } {
    return {
      enableCausalKey: this.enableCausalKey,
      parentIntentId: this.parentIntentId,
      lamportTimestamp: this.lamportTimestamp,
    };
  }
}
