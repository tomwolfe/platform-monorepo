/**
 * Consumer-Driven Contract (CDC) Testing for Tools
 *
 * Problem Solved: Reactive Logic Drift Detection
 * - Current system detects drift AFTER deployment (reactive)
 * - Need proactive prevention before breaking changes reach production
 *
 * Solution: Pact-Style Contract Testing
 * - Before deploying schema changes, run tests against historical traces
 * - If proposed schema would have broken >10% of past executions, CI fails
 * - Turns "Logic Drift Detection" (reactive) into "Drift Prevention" (proactive)
 *
 * Architecture:
 * 1. Trace Collector: Captures successful tool invocations with parameters
 * 2. Contract Generator: Builds expected schema contracts from traces
 * 3. Schema Validator: Tests proposed schemas against historical contracts
 * 4. CI Integration: Fails build if breaking changes detected
 *
 * Usage:
 * ```typescript
 * // In CI/CD pipeline
 * const cdcTester = createContractTester();
 * 
 * const result = await cdcTester.testSchemaChange({
 *   toolName: 'createReservation',
 *   currentSchema: currentTool.schema,
 *   proposedSchema: newTool.schema,
 *   minSuccessRate: 0.90, // 90% of historical traces must pass
 * });
 * 
 * if (!result.passed) {
 *   console.error('Breaking change detected:', result.breakingChanges);
 *   process.exit(1); // Fail CI
 * }
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { z } from "zod";
import { Redis } from "@upstash/redis";
import { getRedisClient, ServiceNamespace } from "../redis";
import { SchemaAnalyzer, type SchemaDiff } from "./semantic-versioning";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Historical trace of tool execution
 */
export interface ToolExecutionTrace {
  traceId: string;
  executionId: string;
  toolName: string;
  toolVersion?: string;
  schemaHash: string;
  // Input parameters that succeeded
  inputParameters: Record<string, unknown>;
  // Output that was produced
  output?: unknown;
  // Execution metadata
  latencyMs: number;
  timestamp: string;
  // Context (user, session, etc.)
  context?: {
    userId?: string;
    intentId?: string;
    workflowId?: string;
  };
}

/**
 * Contract generated from historical traces
 */
export interface ToolContract {
  toolName: string;
  schemaHash: string;
  // Parameter patterns observed in successful executions
  parameterPatterns: {
    // Required parameters (always present)
    required: string[];
    // Optional parameters (sometimes present)
    optional: string[];
    // Parameter type observations
    types: Record<string, {
      observedTypes: string[];
      mostCommonType: string;
      sampleValues: unknown[];
    }>;
    // Parameter value constraints observed
    constraints: Record<string, {
      type: "range" | "enum" | "pattern" | "length";
      value: unknown;
    }>;
  };
  // Sample successful invocations
  successfulExecutions: ToolExecutionTrace[];
  // Contract metadata
  createdAt: string;
  traceCount: number;
}

/**
 * Schema change test result
 */
export interface ContractTestResult {
  passed: boolean;
  toolName: string;
  // Percentage of historical traces that would still work
  successRate: number;
  // Total traces tested
  totalTraces: number;
  // Traces that would fail with new schema
  failingTraces: Array<{
    traceId: string;
    reason: string;
    failingParameter?: string;
  }>;
  // Breaking changes detected
  breakingChanges: Array<{
    type: string;
    description: string;
    affectedParameters: string[];
    severity: "critical" | "high" | "medium" | "low";
  }>;
  // Recommendations for safe migration
  recommendations: string[];
  // Schema diff summary
  schemaDiff?: SchemaDiff;
}

/**
 * Contract testing configuration
 */
export interface ContractTesterConfig {
  redis: Redis;
  /** Minimum success rate to pass (default: 0.90 = 90%) */
  minSuccessRate: number;
  /** Number of traces to sample per tool (default: 1000) */
  maxTracesToSample: number;
  /** How long to keep trace history (default: 30 days) */
  traceTtlDays: number;
  /** Enable debug logging */
  debug: boolean;
}

const DEFAULT_CONFIG: Required<ContractTesterConfig> = {
  redis: null as any,
  minSuccessRate: 0.90,
  maxTracesToSample: 1000,
  traceTtlDays: 30,
  debug: false,
};

// ============================================================================
// CONTRACT TESTER
// ============================================================================

export class ContractTester {
  private config: Required<ContractTesterConfig>;

  constructor(config: ContractTesterConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ========================================================================
  // KEY HELPERS
  // ========================================================================

  private buildTraceKey(toolName: string, traceId: string): string {
    return `cdc:trace:${toolName}:${traceId}`;
  }

  private buildTraceIndexKey(toolName: string): string {
    return `cdc:trace_index:${toolName}`;
  }

  private buildContractKey(toolName: string): string {
    return `cdc:contract:${toolName}`;
  }

  // ========================================================================
  // TRACE COLLECTION
  // ========================================================================

  /**
   * Record a successful tool execution for contract testing
   * Called after successful tool invocation in production
   */
  async recordSuccessfulExecution(trace: ToolExecutionTrace): Promise<void> {
    const traceKey = this.buildTraceKey(trace.toolName, trace.traceId);
    const traceData = {
      ...trace,
      recordedAt: new Date().toISOString(),
    };

    // Store trace
    await this.config.redis.setex(
      traceKey,
      this.config.traceTtlDays * 24 * 60 * 60,
      JSON.stringify(traceData)
    );

    // Add to tool's trace index (sorted set by timestamp)
    const indexKey = this.buildTraceIndexKey(trace.toolName);
    await this.config.redis.zadd(indexKey, {
      member: trace.traceId,
      score: new Date(trace.timestamp).getTime(),
    });

    // Trim to max traces (keep most recent)
    const currentCount = await this.config.redis.zcard(indexKey);
    if (currentCount > this.config.maxTracesToSample * 2) {
      await this.config.redis.zremrangebyrank(
        indexKey,
        0,
        -(this.config.maxTracesToSample * 2) - 1
      );
    }

    if (this.config.debug) {
      console.log(
        `[ContractTester] Recorded trace ${trace.traceId} for ${trace.toolName}`
      );
    }
  }

  /**
   * Get recent successful traces for a tool
   */
  async getRecentTraces(
    toolName: string,
    limit: number = 100
  ): Promise<ToolExecutionTrace[]> {
    const indexKey = this.buildTraceIndexKey(toolName);

    // Get most recent trace IDs (Upstash uses zrange with negative indices for reverse)
    const traceIds = await this.config.redis.zrange(
      indexKey,
      -limit,
      -1
    ) as string[];

    // Fetch all traces in parallel
    const tracePromises = traceIds.map(async (traceId) => {
      const traceKey = this.buildTraceKey(toolName, traceId);
      const data = await this.config.redis.get<any>(traceKey);
      
      if (!data) return null;
      
      try {
        return typeof data === "string" ? JSON.parse(data) : data;
      } catch (error) {
        console.warn(`[ContractTester] Failed to parse trace ${traceId}:`, error);
        return null;
      }
    });

    const traces = await Promise.all(tracePromises);
    return traces.filter((t): t is ToolExecutionTrace => t !== null);
  }

  // ========================================================================
  // CONTRACT GENERATION
  // ========================================================================

  /**
   * Generate contract from historical traces
   */
  async generateContract(toolName: string): Promise<ToolContract | null> {
    const traces = await this.getRecentTraces(toolName, this.config.maxTracesToSample);

    if (traces.length === 0) {
      return null;
    }

    // Analyze parameter patterns
    const parameterUsage = new Map<string, {
      count: number;
      types: Map<string, number>;
      values: unknown[];
    }>();

    for (const trace of traces) {
      const params = trace.inputParameters;
      
      for (const [key, value] of Object.entries(params)) {
        if (!parameterUsage.has(key)) {
          parameterUsage.set(key, { count: 0, types: new Map(), values: [] });
        }
        
        const usage = parameterUsage.get(key)!;
        usage.count++;
        
        // Track type
        const type = typeof value;
        usage.types.set(type, (usage.types.get(type) || 0) + 1);
        
        // Sample values (keep up to 10)
        if (usage.values.length < 10) {
          usage.values.push(value);
        }
      }
    }

    // Build contract
    const totalTraces = traces.length;
    const requiredParams: string[] = [];
    const optionalParams: string[] = [];
    const types: Record<string, any> = {};
    const constraints: Record<string, any> = {};

    for (const [param, usage] of parameterUsage.entries()) {
      const presenceRate = usage.count / totalTraces;
      
      // Required if present in >95% of executions
      if (presenceRate >= 0.95) {
        requiredParams.push(param);
      } else {
        optionalParams.push(param);
      }

      // Find most common type
      let mostCommonType = "unknown";
      let maxCount = 0;
      for (const [type, count] of usage.types.entries()) {
        if (count > maxCount) {
          maxCount = count;
          mostCommonType = type;
        }
      }

      types[param] = {
        observedTypes: Array.from(usage.types.keys()),
        mostCommonType,
        sampleValues: usage.values.slice(0, 5),
      };
    }

    const contract: ToolContract = {
      toolName,
      schemaHash: traces[0]?.schemaHash || "unknown",
      parameterPatterns: {
        required: requiredParams,
        optional: optionalParams,
        types,
        constraints,
      },
      successfulExecutions: traces.slice(0, 10), // Keep sample
      createdAt: new Date().toISOString(),
      traceCount: traces.length,
    };

    // Store contract
    const contractKey = this.buildContractKey(toolName);
    await this.config.redis.setex(
      contractKey,
      7 * 24 * 60 * 60, // 7 days
      JSON.stringify(contract)
    );

    if (this.config.debug) {
      console.log(
        `[ContractTester] Generated contract for ${toolName} ` +
        `(${requiredParams.length} required, ${optionalParams.length} optional params)`
      );
    }

    return contract;
  }

  /**
   * Get stored contract for a tool
   */
  async getContract(toolName: string): Promise<ToolContract | null> {
    const contractKey = this.buildContractKey(toolName);
    const data = await this.config.redis.get<any>(contractKey);

    if (!data) return null;

    try {
      return typeof data === "string" ? JSON.parse(data) : data;
    } catch (error) {
      console.error(`[ContractTester] Failed to parse contract:`, error);
      return null;
    }
  }

  // ========================================================================
  // SCHEMA CHANGE TESTING
  // ========================================================================

  /**
   * Test proposed schema change against historical traces
   *
   * @param options - Test options
   * @returns Test result with pass/fail and breaking changes
   */
  async testSchemaChange(options: {
    toolName: string;
    currentSchema: z.ZodSchema;
    proposedSchema: z.ZodSchema;
    minSuccessRate?: number;
  }): Promise<ContractTestResult> {
    const { toolName, currentSchema, proposedSchema } = options;
    const minSuccessRate = options.minSuccessRate ?? this.config.minSuccessRate;

    if (this.config.debug) {
      console.log(
        `[ContractTester] Testing schema change for ${toolName} ` +
        `(min success rate: ${(minSuccessRate * 100).toFixed(0)}%)`
      );
    }

    // Get historical traces
    const traces = await this.getRecentTraces(toolName, this.config.maxTracesToSample);

    if (traces.length === 0) {
      return {
        passed: true,
        toolName,
        successRate: 1.0,
        totalTraces: 0,
        failingTraces: [],
        breakingChanges: [],
        recommendations: ["No historical traces found - cannot validate compatibility"],
      };
    }

    // Analyze schema diff
    const schemaDiff = SchemaAnalyzer.compareSchemas(toolName, currentSchema, proposedSchema);

    // Test each trace against proposed schema
    const failingTraces: ContractTestResult["failingTraces"] = [];
    const breakingChangesSet = new Map<string, ContractTestResult["breakingChanges"][0]>();

    for (const trace of traces) {
      const validationResult = this.validateParameters(
        proposedSchema,
        trace.inputParameters
      );

      if (!validationResult.valid) {
        failingTraces.push({
          traceId: trace.traceId,
          reason: validationResult.error || "Unknown validation error",
          failingParameter: validationResult.parameter || "unknown",
        });

        // Categorize breaking change
        const breakingChange = this.categorizeBreakingChange(
          validationResult.error || "Unknown error",
          validationResult.parameter || "unknown"
        );
        
        if (!breakingChangesSet.has(breakingChange.type)) {
          breakingChangesSet.set(breakingChange.type, breakingChange);
        } else {
          // Add affected parameter to existing breaking change
          const existing = breakingChangesSet.get(breakingChange.type)!;
          if (!existing.affectedParameters.includes(validationResult.parameter!)) {
            existing.affectedParameters.push(validationResult.parameter!);
          }
        }
      }
    }

    const successRate = (traces.length - failingTraces.length) / traces.length;
    const breakingChanges = Array.from(breakingChangesSet.values());
    const passed = successRate >= minSuccessRate;

    // Generate recommendations
    const recommendations = this.generateRecommendations(
      schemaDiff,
      breakingChanges,
      successRate
    );

    if (this.config.debug) {
      console.log(
        `[ContractTester] Schema change test: ` +
        `${(successRate * 100).toFixed(1)}% success rate ` +
        `(${failingTraces.length}/${traces.length} failing)`
      );
    }

    return {
      passed,
      toolName,
      successRate,
      totalTraces: traces.length,
      failingTraces: failingTraces.slice(0, 100), // Limit output
      breakingChanges,
      recommendations,
      schemaDiff,
    };
  }

  /**
   * Validate parameters against schema
   */
  private validateParameters(
    schema: z.ZodSchema,
    params: Record<string, unknown>
  ): { valid: boolean; error?: string; parameter?: string } {
    try {
      const result = schema.safeParse(params);
      
      if (!result.success) {
        const firstError = result.error.errors[0];
        return {
          valid: false,
          error: firstError.message,
          parameter: firstError.path.join("."),
        };
      }

      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Categorize breaking change type
   */
  private categorizeBreakingChange(
    error: string,
    parameter?: string
  ): ContractTestResult["breakingChanges"][0] {
    const errorLower = error.toLowerCase();

    if (errorLower.includes("required")) {
      return {
        type: "REQUIRED_FIELD_ADDED",
        description: "New required field added",
        affectedParameters: parameter ? [parameter] : [],
        severity: "critical",
      };
    }

    if (errorLower.includes("expected") && errorLower.includes("received")) {
      return {
        type: "TYPE_CHANGED",
        description: "Field type changed",
        affectedParameters: parameter ? [parameter] : [],
        severity: "critical",
      };
    }

    if (errorLower.includes("invalid")) {
      return {
        type: "VALIDATION_STRICTENED",
        description: "Validation rules made stricter",
        affectedParameters: parameter ? [parameter] : [],
        severity: "high",
      };
    }

    return {
      type: "UNKNOWN_BREAKING_CHANGE",
      description: error,
      affectedParameters: parameter ? [parameter] : [],
      severity: "medium",
    };
  }

  /**
   * Generate migration recommendations
   */
  private generateRecommendations(
    schemaDiff: SchemaDiff,
    breakingChanges: ContractTestResult["breakingChanges"],
    successRate: number
  ): string[] {
    const recommendations: string[] = [];

    // Based on breaking change types
    for (const change of breakingChanges) {
      switch (change.type) {
        case "REQUIRED_FIELD_ADDED":
          recommendations.push(
            `Add optional default value for new required field(s): ${change.affectedParameters.join(", ")}`
          );
          break;
        case "TYPE_CHANGED":
          recommendations.push(
            `Consider using union type to support both old and new types during migration`
          );
          break;
        case "VALIDATION_STRICTENED":
          recommendations.push(
            `Add migration layer to transform old values to new format`
          );
          break;
      }
    }

    // Based on success rate
    if (successRate < 0.5) {
      recommendations.push(
        "CRITICAL: Less than 50% compatibility - consider versioning the tool instead of breaking change"
      );
    } else if (successRate < 0.9) {
      recommendations.push(
        "WARNING: Significant compatibility issues - plan gradual rollout with feature flag"
      );
    }

    // Based on schema diff
    if (schemaDiff.removedFields.length > 0) {
      recommendations.push(
        `Deprecated fields (${schemaDiff.removedFields.map(f => f.name).join(", ")}) ` +
        "should have deprecation period before removal"
      );
    }

    return recommendations;
  }

  // ========================================================================
  // CI INTEGRATION
  // ========================================================================

  /**
   * Run CI check for schema changes
   * Throws error if check fails (for CI/CD pipeline integration)
   */
  async runCiCheck(options: {
    toolName: string;
    currentSchema: z.ZodSchema;
    proposedSchema: z.ZodSchema;
    minSuccessRate?: number;
  }): Promise<void> {
    const result = await this.testSchemaChange(options);

    if (!result.passed) {
      const errorMessage = [
        `CDC Test Failed for ${result.toolName}:`,
        `  Success Rate: ${(result.successRate * 100).toFixed(1)}%`,
        `  Failing Traces: ${result.failingTraces.length}/${result.totalTraces}`,
        `  Breaking Changes: ${result.breakingChanges.length}`,
        "",
        "Breaking Changes:",
        ...result.breakingChanges.map(bc => 
          `  - ${bc.type}: ${bc.description} (affects: ${bc.affectedParameters.join(", ")})`
        ),
        "",
        "Recommendations:",
        ...result.recommendations.map(r => `  - ${r}`),
      ].join("\n");

      throw new Error(errorMessage);
    }

    console.log(
      `[CDC] ✅ Schema change passed for ${result.toolName} ` +
      `(${(result.successRate * 100).toFixed(1)}% compatibility)`
    );
  }

  // ========================================================================
  // CLEANUP
  // ========================================================================

  /**
   * Clean up old traces
   */
  async cleanupOldTraces(toolName?: string): Promise<number> {
    const pattern = toolName 
      ? `cdc:trace:${toolName}:*`
      : "cdc:trace:*:*";

    const keys = await this.config.redis.keys(pattern);
    let deleted = 0;

    for (const key of keys) {
      const ttl = await this.config.redis.ttl(key);
      if (ttl <= 0) {
        await this.config.redis.del(key);
        deleted++;
      }
    }

    if (this.config.debug && deleted > 0) {
      console.log(`[ContractTester] Cleaned up ${deleted} expired traces`);
    }

    return deleted;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createContractTester(options?: {
  redis?: Redis;
  minSuccessRate?: number;
  maxTracesToSample?: number;
  traceTtlDays?: number;
  debug?: boolean;
}): ContractTester {
  const redis = options?.redis || getRedisClient(ServiceNamespace.SHARED);

  return new ContractTester({
    redis,
    minSuccessRate: options?.minSuccessRate || 0.90,
    maxTracesToSample: options?.maxTracesToSample || 1000,
    traceTtlDays: options?.traceTtlDays || 30,
    debug: options?.debug || false,
  });
}

// ============================================================================
// TYPE EXPORTS
// ============================================================================
