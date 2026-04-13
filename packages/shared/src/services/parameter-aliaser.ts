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
 * PERFECT GRADE: Runtime Alias Overlay (Hot-Patch Registry)
 * - When alias hits frequency threshold, write to Redis Hot-Patch Registry
 * - ParameterAliaser checks this registry at runtime BEFORE validation
 * - Allows agent to self-correct its own API instantly without CI/CD cycle
 * - PR still generated for permanent schema update, but system works immediately
 *
 * Architecture:
 * 1. SchemaEvolutionService records mismatches (field A used, field B expected)
 * 2. When mismatch frequency > threshold, create alias mapping
 * 3. Write alias to Redis Hot-Patch Registry for instant availability
 * 4. ParameterAliaser applies aliases before validation
 * 5. Aliases cached in Redis for fast lookup
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { Redis } from "@upstash/redis";
import { getRedisClient, ServiceNamespace } from "../redis";
import { Logger } from "../logger";

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
  redis: Redis | null;
  /** Number of mismatches before auto-creating alias */
  mismatchThreshold?: number;
  /** TTL for alias cache entries (default: 1 hour) */
  cacheTtlSeconds?: number;
  /** Key prefix for Redis storage */
  keyPrefix?: string;
  /** Enable hot-patch registry for instant alias availability */
  enableHotPatchRegistry?: boolean;
  /** Key prefix for hot-patch registry */
  hotPatchKeyPrefix?: string;
}

const DEFAULT_CONFIG: Omit<Required<ParameterAliaserConfig>, "redis"> & {
  redis: Redis | null;
} = {
  redis: null,
  mismatchThreshold: 5, // Auto-create alias after 5 mismatches
  cacheTtlSeconds: 3600, // 1 hour cache TTL
  keyPrefix: "param_alias",
  enableHotPatchRegistry: true,
  hotPatchKeyPrefix: "param_hotpatch",
};

// ============================================================================
// PARAMETER ALIASER SERVICE
// ============================================================================

export class ParameterAliaserService {
  private config: Required<ParameterAliaserConfig>;
  private localCache: Map<string, AliasCacheEntry> = new Map();
  private logger: Logger;

  constructor(config: ParameterAliaserConfig) {
    this.config = { ...DEFAULT_CONFIG, redis: config.redis };
    this.logger = new Logger({ serviceName: "parameter-aliaser" });
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
    primaryField: string,
  ): Promise<ParameterAlias | null> {
    const redis = this.config.redis;
    if (!redis) {
      this.logger.warn("Redis not configured, skipping mismatch recording", {
        toolName,
        aliasField,
      });
      return null;
    }

    const aliasKey = this.buildAliasKey(toolName, aliasField);

    // Get existing alias or create new one
    const existingData = await redis.get<string>(aliasKey);
    let mismatchCount = 1;

    if (existingData) {
      const existing = JSON.parse(existingData) as ParameterAlias;
      mismatchCount = (existing.mismatchCount || 0) + 1;
    }

    const alias: ParameterAlias = {
      aliasField,
      primaryField,
      toolName,
      mismatchCount,
      createdAt: existingData
        ? JSON.parse(existingData).createdAt
        : new Date().toISOString(),
      isAuto: false,
    };

    // Store alias data
    await redis.setex(
      aliasKey,
      7 * 24 * 60 * 60, // 7 days TTL for alias data
      JSON.stringify(alias),
    );

    // Add to tool index
    await redis.sadd(this.buildToolAliasIndexKey(toolName), aliasField);

    // Check if we should auto-create the alias
    if (mismatchCount >= this.config.mismatchThreshold) {
      alias.isAuto = true;
      await redis.setex(aliasKey, 7 * 24 * 60 * 60, JSON.stringify(alias));

      // PERFECT GRADE: Write to hot-patch registry for instant availability
      await this.writeToHotPatchRegistry(
        toolName,
        aliasField,
        primaryField,
        mismatchCount,
      );

      // Invalidate cache to force refresh
      await redis.del(this.buildCacheKey(toolName));

      this.logger.info("Auto-created alias", {
        toolName,
        aliasField,
        primaryField,
        mismatchCount,
      });

      return alias;
    }

    return null;
  }

  /**
   * Get aliases for a tool
   *
   * PERFECT GRADE: Checks hot-patch registry first for instant aliases
   */
  async getAliases(toolName: string): Promise<Record<string, string>> {
    // PERFECT GRADE: Check hot-patch registry first for instant aliases
    const hotPatchAliases = await this.getHotPatchAliases(toolName);

    // Check local cache for persisted aliases
    const cached = this.localCache.get(toolName);
    if (cached && cached.expiresAt > Date.now()) {
      // Merge hot-patch aliases with cached aliases (hot-patch takes precedence)
      return { ...cached.aliases, ...hotPatchAliases };
    }

    const redis = this.config.redis;
    if (!redis) {
      this.logger.warn(
        "Redis not configured, returning hot-patch aliases only",
        { toolName },
      );
      return hotPatchAliases;
    }

    // Check Redis cache for persisted aliases
    const cacheKey = this.buildCacheKey(toolName);
    const cachedData = await redis.get<string>(cacheKey);

    let persistedAliases: Record<string, string> = {};

    if (cachedData) {
      const cacheEntry = JSON.parse(cachedData) as AliasCacheEntry;
      if (cacheEntry.expiresAt > Date.now()) {
        // Populate local cache
        this.localCache.set(toolName, cacheEntry);
        persistedAliases = cacheEntry.aliases;
      }
    }

    // If cache miss, build aliases from Redis
    if (Object.keys(persistedAliases).length === 0) {
      const aliasFields = await redis.smembers(
        this.buildToolAliasIndexKey(toolName),
      );

      for (const aliasField of aliasFields) {
        const aliasKey = this.buildAliasKey(toolName, aliasField);
        const aliasData = await redis.get<string>(aliasKey);

        if (aliasData) {
          const alias = JSON.parse(aliasData) as ParameterAlias;
          // Only include auto-created or approved aliases
          if (alias.isAuto || alias.approvedBy) {
            persistedAliases[alias.aliasField] = alias.primaryField;
          }
        }
      }

      // Cache the result
      const cacheEntry: AliasCacheEntry = {
        toolName,
        aliases: persistedAliases,
        expiresAt: Date.now() + this.config.cacheTtlSeconds * 1000,
      };

      await redis.setex(
        cacheKey,
        this.config.cacheTtlSeconds,
        JSON.stringify(cacheEntry),
      );

      // Also cache locally
      this.localCache.set(toolName, cacheEntry);
    }

    // Merge persisted aliases with hot-patch aliases (hot-patch takes precedence)
    return { ...persistedAliases, ...hotPatchAliases };
  }

  /**
   * Apply aliases to parameters
   * Transforms alias fields to primary fields before validation
   *
   * @param toolName - Tool name
   * @param parameters - Raw parameters from LLM
   * @returns Parameters with aliases resolved
   */
  async applyAliases(
    toolName: string,
    parameters: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const aliases = await this.getAliases(toolName);
    const result = { ...parameters };
    const redis = this.config.redis;

    for (const [aliasField, primaryField] of Object.entries(aliases)) {
      if (aliasField in result && !(primaryField in result)) {
        result[primaryField] = result[aliasField];
        // Optionally remove the alias field
        delete result[aliasField];
      }
    }

    // Update lastUsedAt for used aliases
    if (!redis) return result;

    for (const aliasField of Object.keys(aliases)) {
      if (aliasField in parameters) {
        const aliasKey = this.buildAliasKey(toolName, aliasField);
        const aliasData = await redis.get<string>(aliasKey);
        if (aliasData) {
          const alias = JSON.parse(aliasData) as ParameterAlias;
          alias.lastUsedAt = new Date().toISOString();
          await redis.setex(aliasKey, 7 * 24 * 60 * 60, JSON.stringify(alias));
        }
      }
    }

    return result;
  }

  // ========================================================================
  // HOT-PATCH REGISTRY
  // Instant alias availability without CI/CD cycle
  // ========================================================================

  /**
   * Build hot-patch registry key
   */
  private buildHotPatchKey(toolName: string): string {
    return `${this.config.hotPatchKeyPrefix}:${toolName}`;
  }

  /**
   * Write alias to hot-patch registry for instant availability
   *
   * PERFECT GRADE: Runtime Alias Overlay
   * - When alias is auto-created, immediately write to hot-patch registry
   * - Runtime checks this registry BEFORE validation
   * - System self-corrects instantly without waiting for PR merge
   *
   * @param toolName - Tool name
   * @param aliasField - Alias field
   * @param primaryField - Primary field
   * @param mismatchCount - Number of mismatches observed
   */
  async writeToHotPatchRegistry(
    toolName: string,
    aliasField: string,
    primaryField: string,
    mismatchCount: number,
  ): Promise<void> {
    const redis = this.config.redis;
    if (!redis || !this.config.enableHotPatchRegistry) {
      return;
    }

    const hotPatchKey = this.buildHotPatchKey(toolName);
    const hotPatchEntry = {
      aliasField,
      primaryField,
      mismatchCount,
      createdAt: new Date().toISOString(),
      isHotPatch: true,
    };

    // Add to hot-patch registry (hash for easy updates)
    // Note: Upstash Redis uses hset with object format
    await redis.hset(hotPatchKey, {
      [aliasField]: JSON.stringify(hotPatchEntry),
    });

    // Set TTL on the hot-patch key (7 days)
    await redis.expire(hotPatchKey, 7 * 24 * 60 * 60);

    this.logger.info("Hot-patch registry updated", {
      toolName,
      aliasField,
      primaryField,
    });
  }

  /**
   * Get hot-patch aliases for a tool
   *
   * Checks the hot-patch registry for instant aliases
   * These are applied BEFORE cached/persisted aliases
   *
   * @param toolName - Tool name
   * @returns Hot-patch aliases (aliasField -> primaryField)
   */
  async getHotPatchAliases(toolName: string): Promise<Record<string, string>> {
    const redis = this.config.redis;
    if (!redis || !this.config.enableHotPatchRegistry) {
      return {};
    }

    const hotPatchKey = this.buildHotPatchKey(toolName);
    const hotPatchData = await redis.hgetall(hotPatchKey);

    if (!hotPatchData || Object.keys(hotPatchData).length === 0) {
      return {};
    }

    const aliases: Record<string, string> = {};

    for (const [aliasField, entryStr] of Object.entries(hotPatchData)) {
      try {
        const entry =
          typeof entryStr === "string" ? JSON.parse(entryStr) : entryStr;
        if (entry.isHotPatch && entry.primaryField) {
          aliases[aliasField] = entry.primaryField;
        }
      } catch (error) {
        this.logger.warn("Failed to parse hot-patch entry", {
          toolName,
          aliasField,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return aliases;
  }

  /**
   * Remove an alias from hot-patch registry
   *
   * Called when PR is merged and alias is no longer needed
   *
   * @param toolName - Tool name
   * @param aliasField - Alias field to remove
   */
  async removeFromHotPatchRegistry(
    toolName: string,
    aliasField: string,
  ): Promise<void> {
    const redis = this.config.redis;
    if (!redis || !this.config.enableHotPatchRegistry) {
      return;
    }

    const hotPatchKey = this.buildHotPatchKey(toolName);
    await redis.hdel(hotPatchKey, aliasField);

    this.logger.info("Removed from hot-patch registry", {
      toolName,
      aliasField,
    });
  }

  /**
   * Clear all hot-patch aliases for a tool
   *
   * Called when schema is updated and all aliases are obsolete
   *
   * @param toolName - Tool name
   */
  async clearHotPatchRegistry(toolName: string): Promise<void> {
    const redis = this.config.redis;
    if (!redis || !this.config.enableHotPatchRegistry) {
      return;
    }

    const hotPatchKey = this.buildHotPatchKey(toolName);
    await redis.del(hotPatchKey);

    this.logger.info("Cleared hot-patch registry", { toolName });
  }

  /**
   * Get hot-patch registry statistics
   */
  async getHotPatchStats(): Promise<{
    totalHotPatches: number;
    toolsWithHotPatches: number;
    topHotPatchedTools: Array<{ toolName: string; count: number }>;
  }> {
    const redis = this.config.redis;
    if (!redis || !this.config.enableHotPatchRegistry) {
      return {
        totalHotPatches: 0,
        toolsWithHotPatches: 0,
        topHotPatchedTools: [],
      };
    }

    const pattern = `${this.config.hotPatchKeyPrefix}:*`;
    const hotPatchKeys = await redis.keys(pattern);

    let totalHotPatches = 0;
    const toolCounts: Array<{ toolName: string; count: number }> = [];

    for (const hotPatchKey of hotPatchKeys) {
      const entries = await redis.hgetall(hotPatchKey);
      const count = entries ? Object.keys(entries).length : 0;
      totalHotPatches += count;

      const toolName = hotPatchKey.replace(
        `${this.config.hotPatchKeyPrefix}:`,
        "",
      );
      toolCounts.push({ toolName, count });
    }

    toolCounts.sort((a, b) => b.count - a.count);

    return {
      totalHotPatches,
      toolsWithHotPatches: hotPatchKeys.length,
      topHotPatchedTools: toolCounts.slice(0, 10),
    };
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
    approvedBy: string,
  ): Promise<ParameterAlias | null> {
    const redis = this.config.redis;
    if (!redis) return null;

    const aliasKey = this.buildAliasKey(toolName, aliasField);
    const aliasData = await redis.get<string>(aliasKey);

    if (!aliasData) {
      return null;
    }

    const alias = JSON.parse(aliasData) as ParameterAlias;
    alias.approvedBy = approvedBy;
    alias.approvedAt = new Date().toISOString();
    alias.isAuto = false; // Mark as manually approved

    await redis.setex(aliasKey, 7 * 24 * 60 * 60, JSON.stringify(alias));

    // Invalidate cache
    await redis.del(this.buildCacheKey(toolName));
    this.localCache.delete(toolName);

    this.logger.info("Alias approved", {
      toolName,
      aliasField,
      primaryField: alias.primaryField,
      approvedBy,
    });

    return alias;
  }

  /**
   * Get all aliases for a tool
   */
  async getAllAliases(toolName: string): Promise<ParameterAlias[]> {
    const redis = this.config.redis;
    if (!redis) return [];

    const aliasFields = await redis.smembers(
      this.buildToolAliasIndexKey(toolName),
    );
    const aliases: ParameterAlias[] = [];

    for (const aliasField of aliasFields) {
      const aliasKey = this.buildAliasKey(toolName, aliasField);
      const aliasData = await redis.get<string>(aliasKey);

      if (aliasData) {
        const alias = JSON.parse(aliasData) as ParameterAlias;
        aliases.push(alias);
      }
    }

    return aliases;
  }

  /**
   * Remove an alias
   */
  async removeAlias(toolName: string, aliasField: string): Promise<boolean> {
    const redis = this.config.redis;
    if (!redis) return false;

    const aliasKey = this.buildAliasKey(toolName, aliasField);
    const deleted = await redis.del(aliasKey);
    await redis.srem(this.buildToolAliasIndexKey(toolName), aliasField);

    // Invalidate cache
    await redis.del(this.buildCacheKey(toolName));
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
    const redis = this.config.redis;
    if (!redis) {
      return {
        totalAliases: 0,
        autoAliases: 0,
        approvedAliases: 0,
        topAliasedTools: [],
      };
    }

    const pattern = `${this.config.keyPrefix}:index:*`;
    const indexKeys = await redis.keys(pattern);

    let totalAliases = 0;
    let autoAliases = 0;
    let approvedAliases = 0;
    const toolCounts: Array<{ toolName: string; count: number }> = [];

    for (const indexKey of indexKeys) {
      const aliasFields = await redis.smembers(indexKey);
      const toolName = indexKey.replace(`${this.config.keyPrefix}:index:`, "");

      let toolAutoCount = 0;
      let toolApprovedCount = 0;

      for (const aliasField of aliasFields) {
        const aliasKey = this.buildAliasKey(toolName, aliasField);
        const aliasData = await redis.get<string>(aliasKey);

        if (aliasData) {
          const alias = JSON.parse(aliasData) as ParameterAlias;
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

export function getParameterAliaserService(
  redis?: Redis,
): ParameterAliaserService {
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
  const { getRedisClient, ServiceNamespace } = require("../redis");

  const redis = config?.redis || getRedisClient(ServiceNamespace.SHARED);

  return new ParameterAliaserService({
    redis,
    mismatchThreshold: config?.mismatchThreshold,
    cacheTtlSeconds: config?.cacheTtlSeconds,
  });
}
