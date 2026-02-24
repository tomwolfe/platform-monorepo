/**
 * Schema Versioning Service for Jitter-Proof Checkpoints
 *
 * Implements version-pinned checkpoints to handle schema evolution during saga execution.
 * When a saga yields, it stores the schema_hash of every tool in the plan PLUS the git commit SHA.
 * On resume, if the current tool's hash has changed OR the git commit differs, the system detects
 * "Logic Drift" and can trigger an automatic REFLECTING state.
 *
 * Features:
 * - Tool schema versioning (hash-based)
 * - Orchestrator version pinning (git commit SHA)
 * - Drift detection for both tool and orchestrator changes
 * - Parameter mapping suggestions for schema evolution
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { z } from "zod";
import { Redis } from "@upstash/redis";
import { getRedisClient, ServiceNamespace } from "../redis";
import { generateSchemaHash, AllToolsMap, getTypedToolEntry } from "@repo/mcp-protocol";

// ============================================================================
// SCHEMAS
// ============================================================================

/**
 * Tool version record stored in checkpoint
 */
export const ToolVersionRecordSchema = z.object({
  toolName: z.string(),
  schemaHash: z.string(),
  version: z.string(),
  capturedAt: z.string().datetime(),
});

export type ToolVersionRecord = z.infer<typeof ToolVersionRecordSchema>;

/**
 * Schema versioning metadata attached to checkpoints
 * Now includes orchestrator version (git commit SHA) for logic pinning
 */
export const SchemaVersioningMetadataSchema = z.object({
  // Map of tool names to their version records at checkpoint time
  toolVersions: z.record(z.string(), ToolVersionRecordSchema),
  // Schema registry version used when checkpoint was created
  registryVersion: z.string(),
  // Git commit SHA of the orchestrator when checkpoint was created
  orchestratorGitSha: z.string().optional(),
  // Timestamp when versioning metadata was created
  capturedAt: z.string().datetime(),
});

export type SchemaVersioningMetadata = z.infer<typeof SchemaVersioningMetadataSchema>;

/**
 * Schema drift detection result
 * Now includes orchestrator drift detection
 */
export const SchemaDriftResultSchema = z.object({
  hasDrift: z.boolean(),
  driftedTools: z.array(z.object({
    toolName: z.string(),
    oldHash: z.string(),
    newHash: z.string(),
    severity: z.enum(["minor", "major", "breaking"]),
  })),
  hasOrchestratorDrift: z.boolean(),
  oldOrchestratorSha: z.string().optional(),
  newOrchestratorSha: z.string().optional(),
  requiresReflection: z.boolean(),
  recommendation: z.string(),
});

export type SchemaDriftResult = z.infer<typeof SchemaDriftResultSchema>;

/**
 * Parameter mapping suggestion for schema evolution
 */
export const ParameterMappingSchema = z.object({
  toolName: z.string(),
  // Map from old parameter names to new parameter names
  fieldMappings: z.record(z.string(), z.string()),
  // Fields that were removed (may need default values)
  removedFields: z.array(z.string()),
  // Fields that were added (may need to be populated)
  addedFields: z.array(z.string()),
  // Suggested transformation logic
  transformationHints: z.record(z.string(), z.string()).optional(),
});

export type ParameterMapping = z.infer<typeof ParameterMappingSchema>;

// ============================================================================
// SCHEMA VERSIONING SERVICE
// ============================================================================

export interface SchemaVersioningConfig {
  redis: Redis;
  // TTL for version records (default: 24 hours)
  versionTtlSeconds?: number;
  // Index name prefix
  indexPrefix?: string;
}

const DEFAULT_CONFIG: Required<SchemaVersioningConfig> = {
  redis: null as any, // Must be provided
  versionTtlSeconds: 24 * 60 * 60, // 24 hours
  indexPrefix: "schema_versioning",
};

export class SchemaVersioningService {
  private config: Required<SchemaVersioningConfig>;
  private currentRegistryVersion: string;

  constructor(config: SchemaVersioningConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.currentRegistryVersion = this.getRegistryVersion();
  }

  /**
   * Get current registry version (based on git commit SHA)
   */
  private getRegistryVersion(): string {
    // Use git commit SHA for orchestrator version pinning
    // In Vercel: VERCEL_GIT_COMMIT_SHA
    // In GitHub Actions: GITHUB_SHA
    // Fallback to timestamp for local development
    return process.env.VERCEL_GIT_COMMIT_SHA 
      || process.env.GITHUB_SHA 
      || process.env.SCHEMA_REGISTRY_VERSION 
      || `v${Date.now()}`;
  }

  /**
   * Get current git commit SHA for logic pinning
   */
  private getGitCommitSha(): string {
    return process.env.VERCEL_GIT_COMMIT_SHA 
      || process.env.GITHUB_SHA 
      || process.env.GIT_COMMIT_SHA 
      || 'unknown';
  }

  // ========================================================================
  // KEY HELPERS
  // ========================================================================

  private buildVersionKey(toolName: string): string {
    return `${this.config.indexPrefix}:tool:${toolName}`;
  }

  private buildHistoryKey(toolName: string): string {
    return `${this.config.indexPrefix}:history:${toolName}`;
  }

  private buildCheckpointKey(executionId: string): string {
    return `${this.config.indexPrefix}:checkpoint:${executionId}`;
  }

  // ========================================================================
  // TOOL VERSION TRACKING
  // ========================================================================

  /**
   * Capture the current schema version for a tool
   * Called when a checkpoint is created
   */
  async captureToolVersion(toolName: string): Promise<ToolVersionRecord | null> {
    const tool = getTypedToolEntry(toolName as keyof AllToolsMap);
    if (!tool) {
      console.warn(`[SchemaVersioning] Unknown tool: ${toolName}`);
      return null;
    }

    // Generate schema hash
    const schemaHash = await generateSchemaHash(tool.schema);

    // Create version record
    const versionRecord: ToolVersionRecord = {
      toolName,
      schemaHash,
      version: this.currentRegistryVersion,
      capturedAt: new Date().toISOString(),
    };

    // Store current version
    const versionKey = this.buildVersionKey(toolName);
    await this.config.redis.setex(
      versionKey,
      this.config.versionTtlSeconds,
      JSON.stringify(versionRecord)
    );

    // Add to version history (sorted set for timeline)
    const historyKey = this.buildHistoryKey(toolName);
    await this.config.redis.zadd(historyKey, {
      member: JSON.stringify(versionRecord),
      score: Date.now(),
    });

    // Keep only last 10 versions in history
    await this.config.redis.zremrangebyrank(historyKey, 0, -11);

    console.log(
      `[SchemaVersioning] Captured version for ${toolName}: ${schemaHash} (${this.currentRegistryVersion})`
    );

    return versionRecord;
  }

  /**
   * Get current schema version for a tool
   */
  async getCurrentVersion(toolName: string): Promise<ToolVersionRecord | null> {
    const versionKey = this.buildVersionKey(toolName);
    const versionData = await this.config.redis.get<any>(versionKey);

    if (!versionData) return null;

    try {
      return typeof versionData === 'string'
        ? JSON.parse(versionData)
        : versionData;
    } catch (error) {
      console.error(`[SchemaVersioning] Failed to parse version for ${toolName}:`, error);
      return null;
    }
  }

  /**
   * Get version history for a tool
   */
  async getVersionHistory(toolName: string, limit: number = 10): Promise<ToolVersionRecord[]> {
    const historyKey = this.buildHistoryKey(toolName);
    const historyData = await this.config.redis.zrange(
      historyKey,
      -limit,
      -1
    ) as string[];

    return historyData.map(data => {
      try {
        return typeof data === 'string' ? JSON.parse(data) : data;
      } catch (error) {
        console.warn(`[SchemaVersioning] Failed to parse history entry:`, error);
        return null;
      }
    }).filter((v): v is ToolVersionRecord => v !== null);
  }

  // ========================================================================
  // CHECKPOINT VERSIONING
  // ========================================================================

  /**
   * Capture schema versioning metadata for a checkpoint
   * Called when a saga yields to persist state
   * Includes orchestrator git commit SHA for logic pinning
   */
  async captureCheckpointMetadata(
    executionId: string,
    toolNames: string[]
  ): Promise<SchemaVersioningMetadata> {
    const toolVersions: Record<string, ToolVersionRecord> = {};

    // Capture version for each tool in the plan
    for (const toolName of toolNames) {
      const version = await this.captureToolVersion(toolName);
      if (version) {
        toolVersions[toolName] = version;
      }
    }

    const metadata: SchemaVersioningMetadata = {
      toolVersions,
      registryVersion: this.currentRegistryVersion,
      orchestratorGitSha: this.getGitCommitSha(),
      capturedAt: new Date().toISOString(),
    };

    // Store checkpoint metadata
    const checkpointKey = this.buildCheckpointKey(executionId);
    await this.config.redis.setex(
      checkpointKey,
      this.config.versionTtlSeconds,
      JSON.stringify(metadata)
    );

    console.log(
      `[SchemaVersioning] Captured checkpoint metadata for ${executionId} ` +
      `with ${Object.keys(toolVersions).length} tools (orchestrator: ${metadata.orchestratorGitSha})`
    );

    return metadata;
  }

  /**
   * Get checkpoint metadata for an execution
   */
  async getCheckpointMetadata(executionId: string): Promise<SchemaVersioningMetadata | null> {
    const checkpointKey = this.buildCheckpointKey(executionId);
    const metadata = await this.config.redis.get<any>(checkpointKey);

    if (!metadata) return null;

    try {
      return typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    } catch (error) {
      console.error(`[SchemaVersioning] Failed to parse checkpoint metadata:`, error);
      return null;
    }
  }

  // ========================================================================
  // SCHEMA DRIFT DETECTION
  // ========================================================================

  /**
   * Detect schema drift between checkpoint and current state
   * Also detects orchestrator logic drift (git commit changes)
   * Called when a saga resumes from checkpoint
   */
  async detectDrift(
    executionId: string,
    toolNames: string[]
  ): Promise<SchemaDriftResult> {
    // Get checkpoint metadata
    const checkpointMetadata = await this.getCheckpointMetadata(executionId);

    if (!checkpointMetadata) {
      return {
        hasDrift: false,
        driftedTools: [],
        hasOrchestratorDrift: false,
        requiresReflection: false,
        recommendation: "No checkpoint metadata found - assuming no drift",
      };
    }

    const driftedTools: Array<{
      toolName: string;
      oldHash: string;
      newHash: string;
      severity: "minor" | "major" | "breaking";
    }> = [];

    // Check each tool for drift
    for (const toolName of toolNames) {
      const checkpointVersion = checkpointMetadata.toolVersions[toolName];
      if (!checkpointVersion) continue;

      const currentVersion = await this.getCurrentVersion(toolName);

      if (!currentVersion) {
        // Tool no longer exists - breaking change
        driftedTools.push({
          toolName,
          oldHash: checkpointVersion.schemaHash,
          newHash: "REMOVED",
          severity: "breaking",
        });
      } else if (checkpointVersion.schemaHash !== currentVersion.schemaHash) {
        // Schema hash changed - determine severity
        const severity = await this.assessDriftSeverity(toolName, checkpointVersion, currentVersion);
        driftedTools.push({
          toolName,
          oldHash: checkpointVersion.schemaHash,
          newHash: currentVersion.schemaHash,
          severity,
        });
      }
    }

    // Check for orchestrator logic drift
    const currentGitSha = this.getGitCommitSha();
    const hasOrchestratorDrift = !!(checkpointMetadata.orchestratorGitSha
      && checkpointMetadata.orchestratorGitSha !== 'unknown'
      && currentGitSha !== 'unknown'
      && checkpointMetadata.orchestratorGitSha !== currentGitSha);

    const hasDrift = driftedTools.length > 0 || hasOrchestratorDrift;
    const requiresReflection = driftedTools.some(t => t.severity === "breaking" || t.severity === "major") || hasOrchestratorDrift;

    let recommendation = "No schema drift detected - safe to resume";
    if (hasDrift) {
      const reasons = [];
      if (driftedTools.length > 0) {
        reasons.push(`Tool schema changes: ${driftedTools.map(t => t.toolName).join(", ")}`);
      }
      if (hasOrchestratorDrift) {
        reasons.push(`Orchestrator logic change: ${checkpointMetadata.orchestratorGitSha} -> ${currentGitSha}`);
      }
      
      if (requiresReflection) {
        recommendation = `Logic drift detected (${reasons.join("; ")}). ` +
          "Trigger REFLECTING state for parameter mapping or logic re-evaluation.";
      } else {
        recommendation = `Minor drift detected (${reasons.join("; ")}). ` +
          "Can resume with caution - monitor for errors.";
      }
    }

    return {
      hasDrift,
      driftedTools,
      hasOrchestratorDrift: !!hasOrchestratorDrift,
      oldOrchestratorSha: checkpointMetadata.orchestratorGitSha,
      newOrchestratorSha: currentGitSha,
      requiresReflection: !!requiresReflection,
      recommendation,
    };
  }

  /**
   * Assess the severity of schema drift
   */
  private async assessDriftSeverity(
    toolName: string,
    oldVersion: ToolVersionRecord,
    newVersion: ToolVersionRecord
  ): Promise<"minor" | "major" | "breaking"> {
    const tool = getTypedToolEntry(toolName as keyof AllToolsMap);
    if (!tool) return "breaking";

    // Get old and new schema shapes
    const oldShape = "shape" in tool.schema ? Object.keys(tool.schema.shape as object) : [];

    // For now, use a simple heuristic:
    // - If required fields changed: breaking
    // - If optional fields added/removed: minor
    // - If field types changed: major

    // In production, you'd compare the actual Zod schemas in detail
    // This is a simplified version

    const newShape = "shape" in tool.schema ? Object.keys(tool.schema.shape as object) : [];

    const addedFields = newShape.filter(f => !oldShape.includes(f));
    const removedFields = oldShape.filter(f => !newShape.includes(f));

    if (removedFields.length > 0) {
      // Removing fields is potentially breaking
      return "breaking";
    }

    if (addedFields.length > 2) {
      // Adding many fields is a major change
      return "major";
    }

    // Adding 1-2 fields is minor
    return "minor";
  }

  // ========================================================================
  // PARAMETER MAPPING
  // ========================================================================

  /**
   * Generate parameter mapping suggestions for drifted schemas
   */
  async generateParameterMapping(
    toolName: string,
    oldCheckpointVersion: ToolVersionRecord,
    newCurrentVersion: ToolVersionRecord
  ): Promise<ParameterMapping | null> {
    const tool = getTypedToolEntry(toolName as keyof AllToolsMap);
    if (!tool) return null;

    // Get current schema fields
    const currentShape = "shape" in tool.schema ? Object.keys(tool.schema.shape as object) : [];
    const oldShape = Object.keys(oldCheckpointVersion.schemaHash)
      .filter(k => k !== 'schemaHash' && k !== 'version' && k !== 'capturedAt');

    const removedFields = oldShape.filter(f => !currentShape.includes(f));
    const addedFields = currentShape.filter(f => !oldShape.includes(f));

    // Generate field mappings (simple heuristic - in production, use LLM)
    const fieldMappings: Record<string, string> = {};

    // Try to match removed fields to added fields by similarity
    for (const removedField of removedFields) {
      for (const addedField of addedFields) {
        // Simple string similarity check
        if (this.stringSimilarity(removedField, addedField) > 0.7) {
          fieldMappings[removedField] = addedField;
          break;
        }
      }
    }

    return {
      toolName,
      fieldMappings,
      removedFields,
      addedFields,
      transformationHints: this.generateTransformationHints(removedFields, addedFields),
    };
  }

  /**
   * Generate transformation hints for parameter mapping
   */
  private generateTransformationHints(
    removedFields: string[],
    addedFields: string[]
  ): Record<string, string> {
    const hints: Record<string, string> = {};

    // Common transformation patterns
    for (const field of addedFields) {
      if (field.endsWith('_at') || field.endsWith('At')) {
        hints[field] = "Use current timestamp (new Date().toISOString())";
      } else if (field.endsWith('_id') || field.endsWith('Id')) {
        hints[field] = "Use UUID from context or generate with crypto.randomUUID()";
      } else if (field === 'metadata' || field === 'options') {
        hints[field] = "Use empty object {} as default";
      }
    }

    return hints;
  }

  /**
   * Calculate string similarity (Levenshtein distance based)
   */
  private stringSimilarity(a: string, b: string): number {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1;

    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  /**
   * Calculate Levenshtein distance between two strings
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

  // ========================================================================
  // CLEANUP
  // ========================================================================

  /**
   * Clean up expired checkpoint metadata
   */
  async cleanupExpiredCheckpoints(): Promise<number> {
    const pattern = `${this.config.indexPrefix}:checkpoint:*`;
    const keys = await this.config.redis.keys(pattern);

    let deletedCount = 0;
    for (const key of keys) {
      const ttl = await this.config.redis.ttl(key);
      if (ttl <= 0) {
        await this.config.redis.del(key);
        deletedCount++;
      }
    }

    console.log(`[SchemaVersioning] Cleaned up ${deletedCount} expired checkpoints`);
    return deletedCount;
  }
}

// ============================================================================
// FACTORY
// Create schema versioning service
// ============================================================================

export function createSchemaVersioningService(options?: {
  redis?: Redis;
  versionTtlSeconds?: number;
}): SchemaVersioningService {
  const redis = options?.redis || getRedisClient(ServiceNamespace.SHARED);

  return new SchemaVersioningService({
    redis,
    versionTtlSeconds: options?.versionTtlSeconds,
  });
}
