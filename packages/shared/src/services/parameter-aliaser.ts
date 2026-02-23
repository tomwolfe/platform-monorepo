/**
 * Parameter Aliaser Service - Automated Schema Evolution
 *
 * Problem Solved: LLM "Hallucination" of Field Names
 * - LLM consistently sends `user_notes` but schema expects `notes`
 * - LLM sends `reservation_time` but schema expects `time`
 * - Current system rejects these as validation errors
 *
 * Solution: Runtime Parameter Aliasing
 * - Track repeated normalization failures for specific field patterns
 * - Automatically create aliases when frequency threshold is reached
 * - Apply aliases transparently before validation
 *
 * Architecture:
 * 1. SchemaEvolutionService records mismatches (field A used, field B expected)
 * 2. When mismatch frequency > threshold, create alias mapping
 * 3. ParameterAliaser applies aliases before validation
 * 4. Aliases cached in Redis for fast lookup
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { Redis } from '@upstash/redis';
import { getRedisClient, ServiceNamespace } from '../redis';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface ParameterAlias {
  /** The field name the LLM uses */
  aliasField: string;
  /** The actual schema field name */
  primaryField: string;
  /** Tool name this alias applies to */
  toolName: string;
  /** Number of times this mismatch was observed */
  mismatchCount: number;
  /** When this alias was created */
  createdAt: string;
  /** When this alias was last used */
  lastUsedAt?: string;
  /** Whether this alias is auto-generated or manually approved */
  isAuto: boolean;
  /** Manual approval metadata */
  approvedBy?: string;
  approvedAt?: string;
}

export interface AliasCacheEntry {
  toolName: string;
  aliases: Record<string, string>; // aliasField -> primaryField
  expiresAt: number;
}

export interface ParameterAliaserConfig {
  redis: Redis;
  /** Number of mismatches before auto-creating alias */
  mismatchThreshold?: number;
  /** TTL for alias cache entries (default: 1 hour) */
  cacheTtlSeconds?: number;
  /** Key prefix for Redis storage */
  keyPrefix?: string;
}

const DEFAULT_CONFIG: Required<ParameterAliaserConfig> = {
  redis: null as any,
  mismatchThreshold: 5, // Auto-create alias after 5 mismatches
  cacheTtlSeconds: 3600, // 1 hour cache TTL
  keyPrefix: 'param_alias',
};

// ============================================================================
// PARAMETER ALIASER SERVICE
// ============================================================================

export class ParameterAliaserService {
  private config: Required<ParameterAliaserConfig>;
  private localCache: Map<string, AliasCacheEntry> = new Map();

  constructor(config: ParameterAliaserConfig) {
    this.config = { ...DEFAULT_CONFIG, redis: config.redis };
  }

  // ========================================================================
  // KEY HELPERS
  // ========================================================================

  private buildAliasKey(toolName: string, aliasField: string): string {
    return `${this.config.keyPrefix}:${toolName}:${aliasField}`;
  }

  private buildToolAliasIndexKey(toolName: string): string {
    return `${this.config.keyPrefix}:index:${toolName}`;
  }

  private buildCacheKey(toolName: string): string {
    return `${this.config.keyPrefix}:cache:${toolName}`;
  }

  // ========================================================================
  // ALIAS MANAGEMENT
  // ========================================================================

  /**
   * Record a field mismatch
   * When threshold is reached, auto-create an alias
   *
   * @param toolName - Tool name
   * @param aliasField - Field name LLM used
   * @param primaryField - Field name schema expects
   * @returns The created alias if threshold reached, null otherwise
   */
  async recordMismatch(
    toolName: string,
    aliasField: string,
    primaryField: string
  ): Promise<ParameterAlias | null> {
    const aliasKey = this.buildAliasKey(toolName, aliasField);

    // Get existing alias or create new one
    const existingData = await this.config.redis.get<any>(aliasKey);
    let mismatchCount = 1;

    if (existingData) {
      const existing = typeof existingData === 'string' ? JSON.parse(existingData) : existingData;
      mismatchCount = (existing.mismatchCount || 0) + 1;
    }

    const alias: ParameterAlias = {
      aliasField,
      primaryField,
      toolName,
      mismatchCount,
      createdAt: existingData ? (typeof existingData === 'string' ? JSON.parse(existingData).createdAt : existingData.createdAt) : new Date().toISOString(),
      isAuto: false,
    };

    // Store alias data
    await this.config.redis.setex(
      aliasKey,
      7 * 24 * 60 * 60, // 7 days TTL for alias data
      JSON.stringify(alias)
    );

    // Add to tool index
    await this.config.redis.sadd(this.buildToolAliasIndexKey(toolName), aliasField);

    // Check if we should auto-create the alias
    if (mismatchCount >= this.config.mismatchThreshold) {
      alias.isAuto = true;
      await this.config.redis.setex(
        aliasKey,
        7 * 24 * 60 * 60,
        JSON.stringify(alias)
      );

      // Invalidate cache to force refresh
      await this.config.redis.del(this.buildCacheKey(toolName));

      console.log(
        `[ParameterAliaser] Auto-created alias for ${toolName}: ${aliasField} -> ${primaryField} ` +
        `(mismatch count: ${mismatchCount})`
      );

      return alias;
    }

    return null;
  }

  /**
   * Get aliases for a tool
   */
  async getAliases(toolName: string): Promise<Record<string, string>> {
    // Check local cache first
    const cached = this.localCache.get(toolName);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.aliases;
    }

    // Check Redis cache
    const cacheKey = this.buildCacheKey(toolName);
    const cachedData = await this.config.redis.get<any>(cacheKey);

    if (cachedData) {
      const cacheEntry = typeof cachedData === 'string' ? JSON.parse(cachedData) : cachedData;
      if (cacheEntry.expiresAt > Date.now()) {
        // Populate local cache
        this.localCache.set(toolName, cacheEntry);
        return cacheEntry.aliases;
      }
    }

    // Build aliases from Redis
    const aliases: Record<string, string> = {};
    const aliasFields = await this.config.redis.smembers(this.buildToolAliasIndexKey(toolName));

    for (const aliasField of aliasFields) {
      const aliasKey = this.buildAliasKey(toolName, aliasField);
      const aliasData = await this.config.redis.get<any>(aliasKey);

      if (aliasData) {
        const alias = typeof aliasData === 'string' ? JSON.parse(aliasData) : aliasData;
        // Only include auto-created or approved aliases
        if (alias.isAuto || alias.approvedBy) {
          aliases[alias.aliasField] = alias.primaryField;
        }
      }
    }

    // Cache the result
    const cacheEntry: AliasCacheEntry = {
      toolName,
      aliases,
      expiresAt: Date.now() + this.config.cacheTtlSeconds * 1000,
    };

    await this.config.redis.setex(
      cacheKey,
      this.config.cacheTtlSeconds,
      JSON.stringify(cacheEntry)
    );

    // Also cache locally
    this.localCache.set(toolName, cacheEntry);

    return aliases;
  }

  /**
   * Apply aliases to parameters
   * Transforms alias fields to primary fields before validation
   *
   * @param toolName - Tool name
   * @param parameters - Raw parameters from LLM
   * @returns Parameters with aliases resolved
   */
  async applyAliases(toolName: string, parameters: Record<string, unknown>): Promise<Record<string, unknown>> {
    const aliases = await this.getAliases(toolName);
    const result = { ...parameters };

    for (const [aliasField, primaryField] of Object.entries(aliases)) {
      if (aliasField in result && !(primaryField in result)) {
        result[primaryField] = result[aliasField];
        // Optionally remove the alias field
        delete result[aliasField];
      }
    }

    // Update lastUsedAt for used aliases
    for (const aliasField of Object.keys(aliases)) {
      if (aliasField in parameters) {
        const aliasKey = this.buildAliasKey(toolName, aliasField);
        const aliasData = await this.config.redis.get<any>(aliasKey);
        if (aliasData) {
          const alias = typeof aliasData === 'string' ? JSON.parse(aliasData) : aliasData;
          alias.lastUsedAt = new Date().toISOString();
          await this.config.redis.setex(
            aliasKey,
            7 * 24 * 60 * 60,
            JSON.stringify(alias)
          );
        }
      }
    }

    return result;
  }

  /**
   * Manually approve an alias
   *
   * @param toolName - Tool name
   * @param aliasField - Alias field to approve
   * @param approvedBy - User ID who approved
   * @returns The approved alias or null if not found
   */
  async approveAlias(
    toolName: string,
    aliasField: string,
    approvedBy: string
  ): Promise<ParameterAlias | null> {
    const aliasKey = this.buildAliasKey(toolName, aliasField);
    const aliasData = await this.config.redis.get<any>(aliasKey);

    if (!aliasData) {
      return null;
    }

    const alias = typeof aliasData === 'string' ? JSON.parse(aliasData) : aliasData;
    alias.approvedBy = approvedBy;
    alias.approvedAt = new Date().toISOString();
    alias.isAuto = false; // Mark as manually approved

    await this.config.redis.setex(
      aliasKey,
      7 * 24 * 60 * 60,
      JSON.stringify(alias)
    );

    // Invalidate cache
    await this.config.redis.del(this.buildCacheKey(toolName));
    this.localCache.delete(toolName);

    console.log(
      `[ParameterAliaser] Alias approved: ${toolName}:${aliasField} -> ${alias.primaryField} by ${approvedBy}`
    );

    return alias;
  }

  /**
   * Get all aliases for a tool
   */
  async getAllAliases(toolName: string): Promise<ParameterAlias[]> {
    const aliasFields = await this.config.redis.smembers(this.buildToolAliasIndexKey(toolName));
    const aliases: ParameterAlias[] = [];

    for (const aliasField of aliasFields) {
      const aliasKey = this.buildAliasKey(toolName, aliasField);
      const aliasData = await this.config.redis.get<any>(aliasKey);

      if (aliasData) {
        const alias = typeof aliasData === 'string' ? JSON.parse(aliasData) : aliasData;
        aliases.push(alias);
      }
    }

    return aliases;
  }

  /**
   * Remove an alias
   */
  async removeAlias(toolName: string, aliasField: string): Promise<boolean> {
    const aliasKey = this.buildAliasKey(toolName, aliasField);
    const deleted = await this.config.redis.del(aliasKey);
    await this.config.redis.srem(this.buildToolAliasIndexKey(toolName), aliasField);

    // Invalidate cache
    await this.config.redis.del(this.buildCacheKey(toolName));
    this.localCache.delete(toolName);

    return deleted > 0;
  }

  /**
   * Get statistics about aliases
   */
  async getStats(): Promise<{
    totalAliases: number;
    autoAliases: number;
    approvedAliases: number;
    topAliasedTools: Array<{ toolName: string; count: number }>;
  }> {
    const pattern = `${this.config.keyPrefix}:index:*`;
    const indexKeys = await this.config.redis.keys(pattern);

    let totalAliases = 0;
    let autoAliases = 0;
    let approvedAliases = 0;
    const toolCounts: Array<{ toolName: string; count: number }> = [];

    for (const indexKey of indexKeys) {
      const aliasFields = await this.config.redis.smembers(indexKey);
      const toolName = indexKey.replace(`${this.config.keyPrefix}:index:`, '');

      let toolAutoCount = 0;
      let toolApprovedCount = 0;

      for (const aliasField of aliasFields) {
        const aliasKey = this.buildAliasKey(toolName, aliasField);
        const aliasData = await this.config.redis.get<any>(aliasKey);

        if (aliasData) {
          const alias = typeof aliasData === 'string' ? JSON.parse(aliasData) : aliasData;
          totalAliases++;

          if (alias.isAuto) {
            autoAliases++;
            toolAutoCount++;
          }
          if (alias.approvedBy) {
            approvedAliases++;
            toolApprovedCount++;
          }
        }
      }

      toolCounts.push({ toolName, count: toolAutoCount + toolApprovedCount });
    }

    toolCounts.sort((a, b) => b.count - a.count);

    return {
      totalAliases,
      autoAliases,
      approvedAliases,
      topAliasedTools: toolCounts.slice(0, 10),
    };
  }
}

// ============================================================================
// FACTORY
// ============================================================================

let defaultParameterAliaser: ParameterAliaserService | null = null;

export function getParameterAliaserService(redis?: Redis): ParameterAliaserService {
  if (!defaultParameterAliaser) {
    const redisClient = redis || getRedisClient(ServiceNamespace.SHARED);
    defaultParameterAliaser = new ParameterAliaserService({
      redis: redisClient,
    });
  }
  return defaultParameterAliaser;
}

export function createParameterAliaserService(config?: {
  redis?: Redis;
  mismatchThreshold?: number;
  cacheTtlSeconds?: number;
}): ParameterAliaserService {
  const { getRedisClient, ServiceNamespace } = require('../redis');

  const redis = config?.redis || getRedisClient(ServiceNamespace.SHARED);

  return new ParameterAliaserService({
    redis,
    mismatchThreshold: config?.mismatchThreshold,
    cacheTtlSeconds: config?.cacheTtlSeconds,
  });
}
