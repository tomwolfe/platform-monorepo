/**
 * Semantic Versioning Enforcement for Tool Breaking Changes
 *
 * Problem Solved: Byzantine Fault Tolerance in Tool Versioning
 * - Current tool versioning is informational only
 * - If a tool has a breaking change (required parameter added), system should:
 *   1. Detect the breaking change semantically (not just hash comparison)
 *   2. Attempt to find a Compatibility Adapter
 *   3. Use specific version of tool mapped in checkpoint metadata
 *
 * Solution: Semantic Version Analysis + Adapter Registry
 * - Analyzes Zod schemas to detect breaking vs non-breaking changes
 * - Maintains registry of compatibility adapters for common migrations
 * - Auto-applies adapters when resuming from checkpoint with schema drift
 *
 * Usage:
 * ```typescript
 * const semver = createSemanticVersioningService();
 * 
 * // Register a compatibility adapter
 * semver.registerAdapter({
 *   toolName: 'createReservation',
 *   fromVersion: '1.0.0',
 *   toVersion: '2.0.0',
 *   adapter: (params) => ({ ...params, partySize: params.partySize || 2 })
 * });
 * 
 * // Check compatibility and apply adapter
 * const result = await semver.checkCompatibility(
 *   'createReservation',
 *   checkpointToolVersions,
 *   currentToolVersions
 * );
 * 
 * if (result.requiresAdapter && result.adapterAvailable) {
 *   const adaptedParams = result.applyAdapter(oldParams);
 * }
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { z } from "zod";
import { Redis } from "@upstash/redis";
import { getRedisClient, ServiceNamespace } from "../redis";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Semantic version components
 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

/**
 * Schema change classification
 */
export type ChangeType = 
  | "BREAKING"      // Required field added/removed, type changed
  | "MAJOR"         // Multiple fields changed
  | "MINOR"         // Optional field added
  | "PATCH"         // No functional change
  | "UNKNOWN";

/**
 * Detailed schema diff result
 */
export interface SchemaDiff {
  toolName: string;
  changeType: ChangeType;
  // Fields added (with whether they're required)
  addedFields: Array<{
    name: string;
    required: boolean;
    type: string;
  }>;
  // Fields removed
  removedFields: Array<{
    name: string;
    wasRequired: boolean;
    type: string;
  }>;
  // Fields with type changes
  typeChanges: Array<{
    name: string;
    oldType: string;
    newType: string;
  }>;
  // Breaking change details
  breakingChanges: Array<{
    type: "REQUIRED_FIELD_ADDED" | "REQUIRED_FIELD_REMOVED" | "TYPE_CHANGED";
    field: string;
    description: string;
  }>;
}

/**
 * Compatibility adapter function
 */
export type CompatibilityAdapter = (
  params: Record<string, unknown>,
  context?: Record<string, unknown>
) => Record<string, unknown>;

/**
 * Registered adapter in the registry
 */
export interface RegisteredAdapter {
  toolName: string;
  fromVersion: string;
  toVersion: string;
  adapter: CompatibilityAdapter;
  description?: string;
  registeredAt: string;
}

/**
 * Compatibility check result
 */
export interface CompatibilityResult {
  toolName: string;
  isCompatible: boolean;
  changeType: ChangeType;
  requiresAdapter: boolean;
  adapterAvailable: boolean;
  applyAdapter: (params: Record<string, unknown>) => Record<string, unknown>;
  warnings: string[];
  schemaDiff?: SchemaDiff;
}

/**
 * Adapter registry query
 */
export interface AdapterQuery {
  toolName?: string;
  fromVersion?: string;
  toVersion?: string;
}

// ============================================================================
// SEMANTIC VERSION UTILITIES
// ============================================================================

export const SemanticVersionUtils = {
  /**
   * Parse semantic version string
   */
  parse(version: string): SemVer | null {
    const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
    if (!match) return null;

    return {
      major: parseInt(match[1], 10),
      minor: parseInt(match[2], 10),
      patch: parseInt(match[3], 10),
      prerelease: match[4],
    };
  },

  /**
   * Compare two semantic versions
   * Returns: -1 if a < b, 0 if a === b, 1 if a > b
   */
  compare(a: string | SemVer, b: string | SemVer): number {
    const aVer = typeof a === "string" ? this.parse(a) : a;
    const bVer = typeof b === "string" ? this.parse(b) : b;

    if (!aVer || !bVer) return 0;

    if (aVer.major !== bVer.major) {
      return aVer.major - bVer.major > 0 ? 1 : -1;
    }

    if (aVer.minor !== bVer.minor) {
      return aVer.minor - bVer.minor > 0 ? 1 : -1;
    }

    if (aVer.patch !== bVer.patch) {
      return aVer.patch - bVer.patch > 0 ? 1 : -1;
    }

    return 0;
  },

  /**
   * Check if version change is breaking (major version change)
   */
  isBreakingChange(from: string, to: string): boolean {
    const fromVer = this.parse(from);
    const toVer = this.parse(to);

    if (!fromVer || !toVer) return false;

    return toVer.major > fromVer.major;
  },

  /**
   * Format semantic version
   */
  format(ver: SemVer): string {
    let result = `${ver.major}.${ver.minor}.${ver.patch}`;
    if (ver.prerelease) {
      result += `-${ver.prerelease}`;
    }
    return result;
  },
};

/**
 * SCHEMA ANALYZER
 * Analyzes Zod schemas to detect breaking changes
 */

export const SchemaAnalyzer = {
  /**
   * Get field type as string representation
   */
  getFieldType(fieldSchema: z.ZodType): string {
    const def = fieldSchema._def;
    
    if (def.typeName === "ZodString") return "string";
    if (def.typeName === "ZodNumber") return "number";
    if (def.typeName === "ZodBoolean") return "boolean";
    if (def.typeName === "ZodArray") return "array";
    if (def.typeName === "ZodObject") return "object";
    if (def.typeName === "ZodOptional") return "optional";
    if (def.typeName === "ZodNullable") return "nullable";
    if (def.typeName === "ZodEnum") return "enum";
    if (def.typeName === "ZodUnion") return "union";
    if (def.typeName === "ZodDate") return "date";
    if (def.typeName === "ZodRecord") return "record";
    
    return "unknown";
  },

  /**
   * Check if field is required
   */
  isRequired(fieldSchema: z.ZodType): boolean {
    const def = fieldSchema._def;
    
    // Optional and nullable fields are not required
    if (def.typeName === "ZodOptional") return false;
    if (def.typeName === "ZodNullable") return false;
    
    return true;
  },

  /**
   * Extract shape from Zod schema
   */
  extractShape(schema: z.ZodSchema): Record<string, z.ZodType> {
    if ("shape" in schema) {
      return (schema as z.ZodObject<any>).shape as Record<string, z.ZodType>;
    }
    return {};
  },

  /**
   * Compare two schemas and generate diff
   */
  compareSchemas(
    toolName: string,
    oldSchema: z.ZodSchema,
    newSchema: z.ZodSchema
  ): SchemaDiff {
    const oldShape = this.extractShape(oldSchema);
    const newShape = this.extractShape(newSchema);

    const oldFields = new Set(Object.keys(oldShape));
    const newFields = new Set(Object.keys(newShape));

    const addedFields: SchemaDiff["addedFields"] = [];
    const removedFields: SchemaDiff["removedFields"] = [];
    const typeChanges: SchemaDiff["typeChanges"] = [];
    const breakingChanges: SchemaDiff["breakingChanges"] = [];

    // Detect added fields
    for (const field of newFields) {
      if (!oldFields.has(field)) {
        const fieldSchema = newShape[field];
        const isRequired = this.isRequired(fieldSchema);
        const type = this.getFieldType(fieldSchema);

        addedFields.push({ name: field, required: isRequired, type });

        // Adding required field is BREAKING
        if (isRequired) {
          breakingChanges.push({
            type: "REQUIRED_FIELD_ADDED",
            field,
            description: `Required field '${field}' (${type}) was added`,
          });
        }
      }
    }

    // Detect removed fields
    for (const field of oldFields) {
      if (!newFields.has(field)) {
        const fieldSchema = oldShape[field];
        const wasRequired = this.isRequired(fieldSchema);
        const type = this.getFieldType(fieldSchema);

        removedFields.push({ name: field, wasRequired, type });

        // Removing required field is BREAKING
        if (wasRequired) {
          breakingChanges.push({
            type: "REQUIRED_FIELD_REMOVED",
            field,
            description: `Required field '${field}' (${type}) was removed`,
          });
        }
      }
    }

    // Detect type changes
    for (const field of oldFields) {
      if (newFields.has(field)) {
        const oldType = this.getFieldType(oldShape[field]);
        const newType = this.getFieldType(newShape[field]);

        if (oldType !== newType) {
          typeChanges.push({ name: field, oldType, newType });
          breakingChanges.push({
            type: "TYPE_CHANGED",
            field,
            description: `Field '${field}' type changed from ${oldType} to ${newType}`,
          });
        }
      }
    }

    // Determine overall change type
    let changeType: ChangeType = "PATCH";

    if (breakingChanges.length > 0) {
      changeType = "BREAKING";
    } else if (addedFields.length > 2 || removedFields.length > 2) {
      changeType = "MAJOR";
    } else if (addedFields.length > 0 || removedFields.length > 0) {
      changeType = "MINOR";
    }

    return {
      toolName,
      changeType,
      addedFields,
      removedFields,
      typeChanges,
      breakingChanges,
    };
  },
};

// ============================================================================
// SEMANTIC VERSIONING SERVICE
// ============================================================================

export interface SemanticVersioningConfig {
  redis: Redis;
  // TTL for adapter registry entries (default: 30 days)
  adapterTtlSeconds?: number;
  // Enable debug logging
  debug?: boolean;
}

const DEFAULT_CONFIG: Required<SemanticVersioningConfig> = {
  redis: null as any, // Must be provided
  adapterTtlSeconds: 30 * 24 * 60 * 60, // 30 days
  debug: false,
};

export class SemanticVersioningService {
  private config: Required<SemanticVersioningConfig>;
  // In-memory adapter cache
  private adapterCache: Map<string, RegisteredAdapter> = new Map();

  constructor(config: SemanticVersioningConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ========================================================================
  // KEY HELPERS
  // ========================================================================

  private buildAdapterKey(toolName: string, fromVersion: string, toVersion: string): string {
    return `semver:adapter:${toolName}:${fromVersion}:${toVersion}`;
  }

  private buildAdapterIndexKey(toolName: string): string {
    return `semver:adapter_index:${toolName}`;
  }

  // ========================================================================
  // ADAPTER REGISTRY
  // ========================================================================

  /**
   * Register a compatibility adapter
   */
  async registerAdapter(adapter: RegisteredAdapter): Promise<void> {
    const key = this.buildAdapterKey(adapter.toolName, adapter.fromVersion, adapter.toVersion);
    
    // Store in Redis
    await this.config.redis.setex(
      key,
      this.config.adapterTtlSeconds,
      JSON.stringify({
        ...adapter,
        registeredAt: new Date().toISOString(),
      })
    );

    // Add to tool's adapter index
    const indexKey = this.buildAdapterIndexKey(adapter.toolName);
    await this.config.redis.sadd(indexKey, `${adapter.fromVersion}:${adapter.toVersion}`);
    await this.config.redis.expire(indexKey, this.config.adapterTtlSeconds);

    // Add to in-memory cache
    const cacheKey = `${adapter.toolName}:${adapter.fromVersion}:${adapter.toVersion}`;
    this.adapterCache.set(cacheKey, adapter);

    if (this.config.debug) {
      console.log(
        `[SemanticVersioning] Registered adapter: ${adapter.toolName} ` +
        `${adapter.fromVersion} -> ${adapter.toVersion}`
      );
    }
  }

  /**
   * Get adapter for specific version transition
   */
  async getAdapter(
    toolName: string,
    fromVersion: string,
    toVersion: string
  ): Promise<CompatibilityAdapter | null> {
    const cacheKey = `${toolName}:${fromVersion}:${toVersion}`;
    
    // Check in-memory cache first
    const cached = this.adapterCache.get(cacheKey);
    if (cached) {
      return cached.adapter;
    }

    // Check Redis
    const key = this.buildAdapterKey(toolName, fromVersion, toVersion);
    const data = await this.config.redis.get<any>(key);

    if (!data) return null;

    try {
      const adapter: RegisteredAdapter = typeof data === 'string' 
        ? JSON.parse(data) 
        : data;
      
      // Cache it
      this.adapterCache.set(cacheKey, adapter);
      
      return adapter.adapter;
    } catch (error) {
      console.error(`[SemanticVersioning] Failed to parse adapter:`, error);
      return null;
    }
  }

  /**
   * List all adapters for a tool
   */
  async listAdapters(toolName: string): Promise<RegisteredAdapter[]> {
    const indexKey = this.buildAdapterIndexKey(toolName);
    const versionPairs = await this.config.redis.smembers(indexKey) as string[];

    const adapters: RegisteredAdapter[] = [];
    for (const pair of versionPairs) {
      const [fromVersion, toVersion] = pair.split(":");
      const adapter = await this.getAdapter(toolName, fromVersion, toVersion);
      
      if (adapter) {
        // Get full adapter info from cache
        const cacheKey = `${toolName}:${fromVersion}:${toVersion}`;
        const cached = this.adapterCache.get(cacheKey);
        if (cached) {
          adapters.push(cached);
        }
      }
    }

    return adapters;
  }

  /**
   * Find best adapter for version transition (may chain multiple adapters)
   */
  async findBestAdapter(
    toolName: string,
    fromVersion: string,
    toVersion: string
  ): Promise<{
    found: boolean;
    adapter?: CompatibilityAdapter;
    chain?: Array<{ from: string; to: string }>;
  }> {
    // Direct adapter?
    const directAdapter = await this.getAdapter(toolName, fromVersion, toVersion);
    if (directAdapter) {
      return {
        found: true,
        adapter: directAdapter,
        chain: [{ from: fromVersion, to: toVersion }],
      };
    }

    // Try to find a chain of adapters
    const chain = await this.findAdapterChain(toolName, fromVersion, toVersion);
    if (chain.length > 0) {
      // Compose chained adapters
      const composedAdapter = await this.composeAdapterChain(toolName, chain);
      if (composedAdapter) {
        return {
          found: true,
          adapter: composedAdapter,
          chain,
        };
      }
    }

    return { found: false };
  }

  /**
   * Find chain of adapters to bridge version gap
   */
  private async findAdapterChain(
    toolName: string,
    fromVersion: string,
    toVersion: string
  ): Promise<Array<{ from: string; to: string }>> {
    const indexKey = this.buildAdapterIndexKey(toolName);
    const versionPairs = await this.config.redis.smembers(indexKey) as string[];

    // Build adjacency list
    const graph = new Map<string, string[]>();
    for (const pair of versionPairs) {
      const [from, to] = pair.split(":");
      if (!graph.has(from)) {
        graph.set(from, []);
      }
      graph.get(from)!.push(to);
    }

    // BFS to find shortest path
    const queue: Array<{ version: string; path: Array<{ from: string; to: string }> }> = [
      { version: fromVersion, path: [] },
    ];
    const visited = new Set<string>([fromVersion]);

    while (queue.length > 0) {
      const { version, path } = queue.shift()!;

      if (SemanticVersionUtils.compare(version, toVersion) === 0) {
        return path;
      }

      const neighbors = graph.get(version) || [];
      for (const next of neighbors) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push({
            version: next,
            path: [...path, { from: version, to: next }],
          });
        }
      }
    }

    return [];
  }

  /**
   * Compose multiple adapters into one
   */
  private async composeAdapterChain(
    toolName: string,
    chain: Array<{ from: string; to: string }>
  ): Promise<CompatibilityAdapter | null> {
    if (chain.length === 0) return null;

    const adapters: CompatibilityAdapter[] = [];
    for (const link of chain) {
      const adapter = await this.getAdapter(toolName, link.from, link.to);
      if (!adapter) return null;
      adapters.push(adapter);
    }

    // Return composed adapter
    return (params: Record<string, unknown>, context?: Record<string, unknown>) => {
      let result = params;
      for (const adapter of adapters) {
        result = adapter(result, context);
      }
      return result;
    };
  }

  // ========================================================================
  // COMPATIBILITY CHECKING
  // ========================================================================

  /**
   * Check compatibility between checkpoint versions and current versions
   */
  async checkCompatibility(
    toolName: string,
    checkpointVersion: { version: string; schemaHash: string },
    currentVersion: { version: string; schemaHash: string },
    oldSchema?: z.ZodSchema,
    newSchema?: z.ZodSchema
  ): Promise<CompatibilityResult> {
    const warnings: string[] = [];
    
    // Same version - compatible
    if (checkpointVersion.schemaHash === currentVersion.schemaHash) {
      return {
        toolName,
        isCompatible: true,
        changeType: "PATCH",
        requiresAdapter: false,
        adapterAvailable: false,
        applyAdapter: (p) => p,
        warnings,
      };
    }

    // Analyze schema diff if schemas provided
    let schemaDiff: SchemaDiff | undefined;
    let changeType: ChangeType = "UNKNOWN";

    if (oldSchema && newSchema) {
      schemaDiff = SchemaAnalyzer.compareSchemas(toolName, oldSchema, newSchema);
      changeType = schemaDiff.changeType;
    } else {
      // Fallback to semver comparison
      const isBreaking = SemanticVersionUtils.isBreakingChange(
        checkpointVersion.version,
        currentVersion.version
      );
      changeType = isBreaking ? "BREAKING" : "MINOR";
    }

    const requiresAdapter = changeType === "BREAKING" || changeType === "MAJOR";
    
    // Find adapter if needed
    let adapterAvailable = false;
    let applyAdapter: CompatibilityAdapter = (p) => p;

    if (requiresAdapter) {
      const adapterResult = await this.findBestAdapter(
        toolName,
        checkpointVersion.version,
        currentVersion.version
      );

      if (adapterResult.found && adapterResult.adapter) {
        adapterAvailable = true;
        applyAdapter = adapterResult.adapter;
      } else {
        warnings.push(
          `No compatibility adapter found for ${toolName} ` +
          `${checkpointVersion.version} -> ${currentVersion.version}`
        );
      }
    }

    return {
      toolName,
      isCompatible: !requiresAdapter || adapterAvailable,
      changeType,
      requiresAdapter,
      adapterAvailable,
      applyAdapter,
      warnings,
      schemaDiff,
    };
  }

  /**
   * Check compatibility for all tools in a plan
   */
  async checkAllToolsCompatibility(
    checkpointToolVersions: Record<string, { version: string; schemaHash: string }>,
    currentToolVersions: Record<string, { version: string; schemaHash: string }>
  ): Promise<{
    allCompatible: boolean;
    results: Record<string, CompatibilityResult>;
    requiresIntervention: boolean;
    recommendation: string;
  }> {
    const results: Record<string, CompatibilityResult> = {};
    let allCompatible = true;
    let requiresIntervention = false;
    const breakingTools: string[] = [];

    for (const [toolName, checkpointVersion] of Object.entries(checkpointToolVersions)) {
      const currentVersion = currentToolVersions[toolName];
      
      if (!currentVersion) {
        // Tool no longer exists - breaking
        results[toolName] = {
          toolName,
          isCompatible: false,
          changeType: "BREAKING",
          requiresAdapter: true,
          adapterAvailable: false,
          applyAdapter: (p) => p,
          warnings: [`Tool '${toolName}' has been removed`],
        };
        allCompatible = false;
        requiresIntervention = true;
        breakingTools.push(toolName);
        continue;
      }

      const result = await this.checkCompatibility(
        toolName,
        checkpointVersion,
        currentVersion
      );

      results[toolName] = result;

      if (!result.isCompatible) {
        allCompatible = false;
        if (result.requiresAdapter && !result.adapterAvailable) {
          requiresIntervention = true;
          breakingTools.push(toolName);
        }
      }
    }

    let recommendation = "All tools compatible - safe to resume";
    if (requiresIntervention) {
      recommendation = `Breaking changes detected in: ${breakingTools.join(", ")}. ` +
        "Manual intervention required or register compatibility adapters.";
    } else if (!allCompatible) {
      recommendation = "Minor incompatibilities detected - adapters available, can resume with caution";
    }

    return {
      allCompatible,
      results,
      requiresIntervention,
      recommendation,
    };
  }

  // ========================================================================
  // ADAPTER GENERATION HELPERS
  // ========================================================================

  /**
   * Generate a default adapter for simple field mappings
   * Uses heuristics to map removed fields to added fields
   */
  generateDefaultAdapter(
    schemaDiff: SchemaDiff
  ): CompatibilityAdapter {
    const fieldMappings: Record<string, string> = {};

    // Try to match removed fields to added fields by name similarity
    for (const removed of schemaDiff.removedFields) {
      for (const added of schemaDiff.addedFields) {
        if (added.required && this.nameSimilarity(removed.name, added.name) > 0.7) {
          fieldMappings[removed.name] = added.name;
          break;
        }
      }
    }

    return (params: Record<string, unknown>) => {
      const result = { ...params };

      // Apply field mappings
      for (const [oldField, newField] of Object.entries(fieldMappings)) {
        if (oldField in result && !(newField in result)) {
          result[newField] = result[oldField];
        }
      }

      // Add default values for new required fields
      for (const added of schemaDiff.addedFields) {
        if (added.required && !(added.name in result)) {
          result[added.name] = this.getDefaultValueForType(added.type);
        }
      }

      return result;
    };
  }

  /**
   * Get default value for a type
   */
  private getDefaultValueForType(type: string): unknown {
    switch (type) {
      case "string": return "";
      case "number": return 0;
      case "boolean": return false;
      case "array": return [];
      case "object": return {};
      default: return null;
    }
  }

  /**
   * Calculate name similarity (simple heuristic)
   */
  private nameSimilarity(a: string, b: string): number {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1;

    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  /**
   * Calculate Levenshtein distance
   */
  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createSemanticVersioningService(options?: {
  redis?: Redis;
  adapterTtlSeconds?: number;
  debug?: boolean;
}): SemanticVersioningService {
  const redis = options?.redis || getRedisClient(ServiceNamespace.SHARED);

  return new SemanticVersioningService({
    redis,
    adapterTtlSeconds: options?.adapterTtlSeconds,
    debug: options?.debug,
  });
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { 
  SemVer, 
  ChangeType, 
  SchemaDiff, 
  CompatibilityAdapter, 
  RegisteredAdapter,
  CompatibilityResult,
  AdapterQuery,
};
