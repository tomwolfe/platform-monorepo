import { Redis } from '@upstash/redis';

export class IdempotencyService {
  constructor(private redis: Redis) {}

  /**
   * Generate a deterministic hash from parameters
   * Uses Web Crypto API for Edge Runtime compatibility
   * Normalizes and sorts parameters to ensure consistent hashing
   * even if LLM sends parameters in different order or with whitespace variations
   */
  private async generateParamsHash(parameters: Record<string, unknown>): Promise<string> {
    // Normalize parameters: sort keys and stringify
    const sortedParams = JSON.stringify(
      Object.entries(parameters)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, this.normalizeValue(value)])
    );
    
    // Use Web Crypto API for Edge Runtime compatibility
    const encoder = new TextEncoder();
    const data = encoder.encode(sortedParams);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    return hashHex.substring(0, 8);
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
   * Enhanced with parameter hashing to prevent duplicate execution
   * when LLM sends slightly different parameters on retry.
   * 
   * @param key - Base key (e.g., `${executionId}:${stepIndex}`)
   * @param parameters - Optional parameters to include in hash for stricter idempotency
   * @returns true if it's a duplicate, false if it's new.
   */
  async isDuplicate(key: string, parameters?: Record<string, unknown>): Promise<boolean> {
    const paramsHash = parameters ? await this.generateParamsHash(parameters) : null;
    const fullKey = paramsHash 
      ? `idempotency:${key}:${paramsHash}`
      : `idempotency:${key}`;
    
    const set = await this.redis.set(fullKey, 'processed', {
      nx: true,
      ex: 24 * 60 * 60, // 24 hours
    });
    return set === null;
  }

  /**
   * Get the idempotency key for debugging/logging
   */
  async getKey(key: string, parameters?: Record<string, unknown>): Promise<string> {
    const paramsHash = parameters ? await this.generateParamsHash(parameters) : null;
    return paramsHash 
      ? `idempotency:${key}:${paramsHash}`
      : `idempotency:${key}`;
  }
}
