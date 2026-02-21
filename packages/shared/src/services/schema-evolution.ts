/**
 * Dynamic Schema Evolution System
 * 
 * Allows the system to propose schema changes based on repeated normalization failures.
 * When the LLM consistently uses parameters that don't match existing schemas,
 * this system detects the mismatch and proposes schema updates.
 * 
 * @package @repo/shared
 * @since 1.0.0
 */

import { z } from "zod";
import { Redis } from "@upstash/redis";
import type { NormalizationResult } from "../normalization";

// ============================================================================
// SCHEMAS
// ============================================================================

/**
 * Schema mismatch event - recorded when normalization fails
 */
export const SchemaMismatchEventSchema = z.object({
  id: z.string().uuid(),
  intentType: z.string(),
  toolName: z.string(),
  timestamp: z.string().datetime(),
  // The parameters the LLM tried to use
  llmParameters: z.record(z.unknown()),
  // The expected schema fields
  expectedFields: z.array(z.string()),
  // Fields the LLM used but weren't expected
  unexpectedFields: z.array(z.string()),
  // Fields the schema expected but LLM didn't provide
  missingFields: z.array(z.string()),
  // Error details from normalization
  errors: z.array(z.object({
    field: z.string(),
    message: z.string(),
    code: z.string().optional(),
  })),
  // Execution context
  executionId: z.string().uuid().optional(),
  userId: z.string().optional(),
});

export type SchemaMismatchEvent = z.infer<typeof SchemaMismatchEventSchema>;

/**
 * Proposed schema change
 */
export const ProposedSchemaChangeSchema = z.object({
  id: z.string().uuid(),
  intentType: z.string(),
  toolName: z.string(),
  // Current schema (serialized)
  currentSchema: z.record(z.unknown()),
  // Proposed new/updated fields
  proposedFields: z.array(z.object({
    name: z.string(),
    type: z.enum(["string", "number", "boolean", "object", "array", "datetime"]),
    required: z.boolean().default(false),
    description: z.string().optional(),
    defaultValue: z.unknown().optional(),
    validation: z.record(z.unknown()).optional(),
  })),
  // Fields to deprecate (optional)
  deprecatedFields: z.array(z.string()).optional(),
  // Reason for change
  reason: z.string(),
  // Evidence: mismatch events that led to this proposal
  evidence: z.array(z.object({
    eventId: z.string().uuid(),
    timestamp: z.string().datetime(),
    unexpectedFields: z.array(z.string()),
  })),
  // Statistics
  mismatchCount: z.number().int().positive(),
  firstMismatchAt: z.string().datetime(),
  lastMismatchAt: z.string().datetime(),
  // Status
  status: z.enum(["pending", "approved", "rejected", "applied"]).default("pending"),
  // Metadata
  createdAt: z.string().datetime(),
  reviewedAt: z.string().datetime().optional(),
  reviewedBy: z.string().optional(),
  reviewNotes: z.string().optional(),
});

export type ProposedSchemaChange = z.infer<typeof ProposedSchemaChangeSchema>;

/**
 * Schema evolution statistics
 */
export const SchemaEvolutionStatsSchema = z.object({
  totalMismatches: z.number().int().nonnegative(),
  totalProposals: z.number().int().nonnegative(),
  pendingProposals: z.number().int().nonnegative(),
  approvedProposals: z.number().int().nonnegative(),
  rejectedProposals: z.number().int().nonnegative(),
  appliedProposals: z.number().int().nonnegative(),
  topMismatchedFields: z.array(z.object({
    field: z.string(),
    count: z.number().int().positive(),
    intentTypes: z.array(z.string()),
  })),
});

export type SchemaEvolutionStats = z.infer<typeof SchemaEvolutionStatsSchema>;

// ============================================================================
// SCHEMA EVOLUTION SERVICE
// Tracks mismatches and proposes schema changes
// ============================================================================

export interface SchemaEvolutionConfig {
  redis: Redis;
  // Number of mismatches before auto-proposing a schema change
  mismatchThreshold?: number;
  // TTL for mismatch events (default: 7 days)
  eventTtlSeconds?: number;
  // Index name prefix
  indexPrefix?: string;
}

const DEFAULT_CONFIG: Required<SchemaEvolutionConfig> = {
  redis: null as any, // Must be provided
  mismatchThreshold: 5,
  eventTtlSeconds: 7 * 24 * 60 * 60, // 7 days
  indexPrefix: "schema_evolution",
};

export class SchemaEvolutionService {
  private config: Required<SchemaEvolutionConfig>;

  constructor(config: SchemaEvolutionConfig) {
    this.config = { ...DEFAULT_CONFIG, redis: config.redis };
  }

  // ========================================================================
  // KEY HELPERS
  // ========================================================================

  private buildMismatchKey(eventId: string): string {
    return `${this.config.indexPrefix}:mismatch:${eventId}`;
  }

  private buildMismatchIndexKey(intentType: string, toolName: string): string {
    return `${this.config.indexPrefix}:index:${intentType}:${toolName}`;
  }

  private buildProposalKey(proposalId: string): string {
    return `${this.config.indexPrefix}:proposal:${proposalId}`;
  }

  private buildProposalIndexKey(status: string): string {
    return `${this.config.indexPrefix}:proposals:${status}`;
  }

  private buildFieldFrequencyKey(): string {
    return `${this.config.indexPrefix}:field_freq`;
  }

  // ========================================================================
  // MISMATCH TRACKING
  // ========================================================================

  /**
   * Record a schema mismatch event
   */
  async recordMismatch(event: Omit<SchemaMismatchEvent, "id">): Promise<SchemaMismatchEvent> {
    const eventId = crypto.randomUUID();
    const completeEvent: SchemaMismatchEvent = {
      ...event,
      id: eventId,
    };

    // Store event
    const key = this.buildMismatchKey(eventId);
    await this.config.redis.setex(key, this.config.eventTtlSeconds, JSON.stringify(completeEvent));

    // Add to index (sorted set by timestamp)
    const indexKey = this.buildMismatchIndexKey(event.intentType, event.toolName);
    const timestamp = new Date(event.timestamp).getTime();
    await this.config.redis.zadd(indexKey, {
      member: eventId,
      score: timestamp,
    });

    // Update field frequency counter
    await this.updateFieldFrequency(event);

    // Check if we should auto-propose a schema change
    const mismatchCount = await this.getMismatchCount(event.intentType, event.toolName);
    if (mismatchCount >= this.config.mismatchThreshold) {
      await this.autoProposeSchemaChange(event.intentType, event.toolName);
    }

    console.log(
      `[SchemaEvolution] Recorded mismatch for ${event.intentType}:${event.toolName} ` +
      `(total: ${mismatchCount}, threshold: ${this.config.mismatchThreshold})`
    );

    return completeEvent;
  }

  /**
   * Get recent mismatches for an intent/tool
   */
  async getRecentMismatches(
    intentType: string,
    toolName: string,
    limit: number = 10
  ): Promise<SchemaMismatchEvent[]> {
    const indexKey = this.buildMismatchIndexKey(intentType, toolName);
    // Use zrange with negative indices for reverse order
    const eventIds = await this.config.redis.zrange(indexKey, -limit, -1) as string[];

    const events: SchemaMismatchEvent[] = [];

    for (const eventId of eventIds) {
      const key = this.buildMismatchKey(eventId);
      const eventData = await this.config.redis.get<any>(key);

      if (eventData) {
        try {
          // Redis may auto-deserialize JSON, so check if already an object
          const event: SchemaMismatchEvent = typeof eventData === 'string' 
            ? JSON.parse(eventData) 
            : eventData;
          events.push(event);
        } catch (error) {
          console.warn(`[SchemaEvolution] Failed to parse mismatch event ${eventId}:`, error);
        }
      }
    }

    return events;
  }

  /**
   * Get mismatch count for an intent/tool
   */
  async getMismatchCount(intentType: string, toolName: string): Promise<number> {
    const indexKey = this.buildMismatchIndexKey(intentType, toolName);
    return await this.config.redis.zcard(indexKey);
  }

  // ========================================================================
  // FIELD FREQUENCY TRACKING
  // ========================================================================

  /**
   * Update frequency counter for unexpected fields
   */
  private async updateFieldFrequency(event: Omit<SchemaMismatchEvent, "id">): Promise<void> {
    const fieldFreqKey = this.buildFieldFrequencyKey();

    for (const field of event.unexpectedFields) {
      // Increment counter for this field
      await this.config.redis.hincrby(fieldFreqKey, field, 1);
      
      // Track which intent types use this field
      const intentSetKey = `${fieldFreqKey}:intents:${field}`;
      await this.config.redis.sadd(intentSetKey, event.intentType);
      
      // Set TTL on field data
      await this.config.redis.expire(fieldFreqKey, this.config.eventTtlSeconds);
      await this.config.redis.expire(intentSetKey, this.config.eventTtlSeconds);
    }
  }

  /**
   * Get most frequently mismatched fields
   */
  async getTopMismatchedFields(limit: number = 10): Promise<Array<{
    field: string;
    count: number;
    intentTypes: string[];
  }>> {
    const fieldFreqKey = this.buildFieldFrequencyKey();
    const fieldCounts = await this.config.redis.hgetall(fieldFreqKey) as Record<string, number>;

    const topFields: Array<{
      field: string;
      count: number;
      intentTypes: string[];
    }> = [];

    for (const [field, count] of Object.entries(fieldCounts)) {
      const intentSetKey = `${fieldFreqKey}:intents:${field}`;
      const intentTypes = await this.config.redis.smembers(intentSetKey) as string[];

      topFields.push({
        field,
        count: count as number,
        intentTypes,
      });
    }

    topFields.sort((a, b) => b.count - a.count);
    return topFields.slice(0, limit);
  }

  // ========================================================================
  // SCHEMA CHANGE PROPOSALS
  // ========================================================================

  /**
   * Auto-propose a schema change based on mismatch patterns
   */
  private async autoProposeSchemaChange(
    intentType: string,
    toolName: string
  ): Promise<ProposedSchemaChange | null> {
    // Check if there's already a pending proposal
    const pendingProposals = await this.getProposals(intentType, toolName, "pending");
    if (pendingProposals.length > 0) {
      console.log(`[SchemaEvolution] Pending proposal already exists for ${intentType}:${toolName}`);
      return null;
    }

    // Get recent mismatches
    const recentMismatches = await this.getRecentMismatches(intentType, toolName, 20);
    if (recentMismatches.length < this.config.mismatchThreshold) {
      return null;
    }

    // Analyze patterns in unexpected fields
    const fieldFrequency = new Map<string, number>();
    for (const mismatch of recentMismatches) {
      for (const field of mismatch.unexpectedFields) {
        fieldFrequency.set(field, (fieldFrequency.get(field) || 0) + 1);
      }
    }

    // Only propose fields that appear in >50% of mismatches
    const consistentFields: string[] = [];
    const threshold = Math.floor(recentMismatches.length * 0.5);
    
    for (const [field, count] of fieldFrequency.entries()) {
      if (count >= threshold) {
        consistentFields.push(field);
      }
    }

    if (consistentFields.length === 0) {
      console.log(`[SchemaEvolution] No consistent field patterns found for ${intentType}:${toolName}`);
      return null;
    }

    // Build proposal
    const proposal: ProposedSchemaChange = {
      id: crypto.randomUUID(),
      intentType,
      toolName,
      currentSchema: {}, // Would need to fetch actual current schema
      proposedFields: consistentFields.map(field => ({
        name: field,
        type: this.inferFieldType(recentMismatches, field),
        required: false,
        description: `Auto-proposed field based on ${fieldFrequency.get(field)} mismatch events`,
      })),
      deprecatedFields: [],
      reason: `Consistent parameter mismatches detected: ${consistentFields.join(", ")}`,
      evidence: recentMismatches.slice(0, 5).map(m => ({
        eventId: m.id,
        timestamp: m.timestamp,
        unexpectedFields: m.unexpectedFields,
      })),
      mismatchCount: recentMismatches.length,
      firstMismatchAt: recentMismatches[recentMismatches.length - 1].timestamp,
      lastMismatchAt: recentMismatches[recentMismatches.length - 1].timestamp,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    // Store proposal
    await this.saveProposal(proposal);

    console.log(
      `[SchemaEvolution] Auto-proposed schema change for ${intentType}:${toolName} ` +
      `with ${proposal.proposedFields.length} new fields`
    );

    return proposal;
  }

  /**
   * Infer field type from mismatch events
   */
  private inferFieldType(
    mismatches: SchemaMismatchEvent[],
    fieldName: string
  ): "string" | "number" | "boolean" | "object" | "array" | "datetime" {
    const values: unknown[] = [];
    
    for (const mismatch of mismatches) {
      if (fieldName in mismatch.llmParameters) {
        values.push(mismatch.llmParameters[fieldName]);
      }
    }

    if (values.length === 0) return "string";

    // Check types
    const types = new Set(values.map(v => typeof v));
    
    if (types.has("boolean")) return "boolean";
    if (types.has("number")) return "number";
    if (Array.isArray(values[0])) return "array";
    if (typeof values[0] === "object" && values[0] !== null) return "object";
    
    // Check if it looks like a datetime string
    if (values.every(v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v as string))) {
      return "datetime";
    }

    return "string";
  }

  /**
   * Save a schema change proposal
   */
  async saveProposal(proposal: ProposedSchemaChange): Promise<void> {
    const key = this.buildProposalKey(proposal.id);
    await this.config.redis.setex(key, this.config.eventTtlSeconds * 2, JSON.stringify(proposal));

    // Add to status index
    const indexKey = this.buildProposalIndexKey(proposal.status);
    await this.config.redis.zadd(indexKey, {
      member: proposal.id,
      score: new Date(proposal.createdAt).getTime(),
    });
  }

  /**
   * Get a proposal by ID
   */
  async getProposal(proposalId: string): Promise<ProposedSchemaChange | null> {
    const key = this.buildProposalKey(proposalId);
    const proposalData = await this.config.redis.get<any>(key);

    if (!proposalData) return null;

    try {
      // Redis may auto-deserialize JSON, so check if already an object
      const proposal: ProposedSchemaChange = typeof proposalData === 'string' 
        ? JSON.parse(proposalData) 
        : proposalData;
      return proposal;
    } catch (error) {
      console.error(`[SchemaEvolution] Failed to parse proposal ${proposalId}:`, error);
      return null;
    }
  }

  /**
   * Get proposals by status
   */
  async getProposals(
    intentType?: string,
    toolName?: string,
    status?: string,
    limit: number = 20
  ): Promise<ProposedSchemaChange[]> {
    let proposalIds: string[];

    if (status) {
      const indexKey = this.buildProposalIndexKey(status);
      // Use zrange with negative indices for reverse order
      proposalIds = await this.config.redis.zrange(indexKey, -limit, -1) as string[];
    } else {
      // Get all proposals (combine all status indexes)
      const allIds = new Set<string>();
      for (const status of ["pending", "approved", "rejected", "applied"]) {
        const indexKey = this.buildProposalIndexKey(status);
        const ids = await this.config.redis.zrange(indexKey, 0, -1) as string[];
        ids.forEach(id => allIds.add(id));
      }
      proposalIds = Array.from(allIds).slice(0, limit);
    }

    const proposals: ProposedSchemaChange[] = [];

    for (const proposalId of proposalIds) {
      const proposal = await this.getProposal(proposalId);
      
      if (proposal) {
        // Filter by intentType and toolName if provided
        if (intentType && proposal.intentType !== intentType) continue;
        if (toolName && proposal.toolName !== toolName) continue;
        
        proposals.push(proposal);
      }
    }

    return proposals;
  }

  /**
   * Review a proposal (approve or reject)
   */
  async reviewProposal(
    proposalId: string,
    approved: boolean,
    reviewedBy: string,
    notes?: string
  ): Promise<ProposedSchemaChange | null> {
    const proposal = await this.getProposal(proposalId);
    if (!proposal) return null;

    // Remove from old status index
    const oldIndexKey = this.buildProposalIndexKey(proposal.status);
    await this.config.redis.zrem(oldIndexKey, proposalId);

    // Update proposal
    proposal.status = approved ? "approved" : "rejected";
    proposal.reviewedAt = new Date().toISOString();
    proposal.reviewedBy = reviewedBy;
    proposal.reviewNotes = notes;

    // Save updated proposal
    await this.saveProposal(proposal);

    console.log(
      `[SchemaEvolution] Proposal ${proposalId} ${approved ? "approved" : "rejected"} by ${reviewedBy}`
    );

    return proposal;
  }

  /**
   * Mark a proposal as applied (after migration is run)
   */
  async markProposalApplied(proposalId: string): Promise<ProposedSchemaChange | null> {
    const proposal = await this.getProposal(proposalId);
    if (!proposal) return null;

    // Remove from old status index
    const oldIndexKey = this.buildProposalIndexKey(proposal.status);
    await this.config.redis.zrem(oldIndexKey, proposalId);

    // Update proposal
    proposal.status = "applied";
    await this.saveProposal(proposal);

    console.log(`[SchemaEvolution] Proposal ${proposalId} marked as applied`);

    return proposal;
  }

  // ========================================================================
  // STATISTICS
  // ========================================================================

  /**
   * Get schema evolution statistics
   */
  async getStats(): Promise<SchemaEvolutionStats> {
    const [pendingCount, approvedCount, rejectedCount, appliedCount] = await Promise.all([
      this.config.redis.zcard(this.buildProposalIndexKey("pending")),
      this.config.redis.zcard(this.buildProposalIndexKey("approved")),
      this.config.redis.zcard(this.buildProposalIndexKey("rejected")),
      this.config.redis.zcard(this.buildProposalIndexKey("applied")),
    ]);

    const topMismatchedFields = await this.getTopMismatchedFields(10);

    return {
      totalMismatches: pendingCount + approvedCount + rejectedCount + appliedCount,
      totalProposals: pendingCount + approvedCount + rejectedCount + appliedCount,
      pendingProposals: pendingCount,
      approvedProposals: approvedCount,
      rejectedProposals: rejectedCount,
      appliedProposals: appliedCount,
      topMismatchedFields,
    };
  }

  // ========================================================================
  // CLEANUP
  // ========================================================================

  /**
   * Clean up old mismatch events
   */
  async cleanupOldEvents(maxAgeDays: number = 7): Promise<number> {
    const cutoffTime = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
    let deletedCount = 0;

    // Get all mismatch index keys
    const pattern = `${this.config.indexPrefix}:index:*`;
    const indexKeys = await this.config.redis.keys(pattern);

    for (const indexKey of indexKeys) {
      // Get events older than cutoff using zrange with score range
      const oldEventIds = await this.config.redis.zrange(
        indexKey,
        "-inf",
        cutoffTime,
        { byScore: true }
      ) as string[];

      for (const eventId of oldEventIds) {
        const key = this.buildMismatchKey(eventId);
        await this.config.redis.del(key);
        await this.config.redis.zrem(indexKey, eventId);
        deletedCount++;
      }
    }

    console.log(`[SchemaEvolution] Cleaned up ${deletedCount} old mismatch events`);
    return deletedCount;
  }
}

// ============================================================================
// NORMALIZATION SERVICE INTEGRATION
// Wrapper for NormalizationService that auto-tracks mismatches
// ============================================================================

/**
 * Enhanced normalization with automatic mismatch tracking
 */
export async function normalizeWithTracking<T>(
  schemaEvolution: SchemaEvolutionService,
  intentType: string,
  toolName: string,
  parameters: Record<string, unknown>,
  expectedSchema: z.ZodType<T>,
  executionId?: string,
  userId?: string
): Promise<NormalizationResult<T>> {
  const result = expectedSchema.safeParse(parameters);

  if (result.success) {
    return { 
      success: true, 
      data: result.data,
      errors: [],
      rawInput: parameters,
    };
  }

  // Extract mismatch details
  const errors = result.error.errors.map(err => ({
    path: err.path.join("."),
    message: err.message,
    code: err.code,
  }));

  // Safely extract expected fields from Zod schema
  const expectedFields: string[] = [];
  if ("shape" in expectedSchema && typeof expectedSchema.shape === "object") {
    expectedFields.push(...Object.keys(expectedSchema.shape as object));
  }
  
  const providedFields = Object.keys(parameters);

  const unexpectedFields = providedFields.filter(f => !expectedFields.includes(f));
  const missingFields = expectedFields.filter(f => !providedFields.includes(f));

  // Record mismatch event
  const mismatchEvent: Omit<SchemaMismatchEvent, "id"> = {
    intentType,
    toolName,
    timestamp: new Date().toISOString(),
    llmParameters: parameters,
    expectedFields,
    unexpectedFields,
    missingFields,
    errors: errors.map(e => ({ field: e.path, message: e.message, code: e.code })),
    executionId,
    userId,
  };

  await schemaEvolution.recordMismatch(mismatchEvent);

  return {
    success: false,
    errors,
    rawInput: parameters,
  };
}

// ============================================================================
// FACTORY
// Create schema evolution service
// ============================================================================

export function createSchemaEvolutionService(options?: {
  redis?: Redis;
  mismatchThreshold?: number;
  eventTtlSeconds?: number;
}): SchemaEvolutionService {
  const { getRedisClient, ServiceNamespace } = require("../redis");
  
  const redis = options?.redis || getRedisClient(ServiceNamespace.SHARED);

  return new SchemaEvolutionService({
    redis,
    mismatchThreshold: options?.mismatchThreshold,
    eventTtlSeconds: options?.eventTtlSeconds,
  });
}
