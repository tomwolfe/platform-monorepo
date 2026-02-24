/**
 * Automated Repair Agent - Self-Healing Dead Letter Queue
 *
 * Problem Solved: Manual DLQ Intervention Bottleneck
 * - When sagas enter DLQ, they wait for human intervention
 * - Many failures are fixable automatically (parameter mismatches, transient errors)
 *
 * Solution: AI-Powered Repair Agent
 * - Analyzes failure context, state diff, and code version
 * - Generates suggested fix payload using LLM
 * - Applies fix in SHADOW_DRY_RUN mode
 * - If validation passes, auto-resumes the saga
 * - Falls back to human escalation only when truly needed
 *
 * Repair Strategies:
 * 1. PARAMETER_MISMATCH - Adapt parameters using semantic versioning
 * 2. TRANSIENT_ERROR - Retry with exponential backoff
 * 3. LOGIC_DRIFT - Generate parameter mapping for schema changes
 * 4. TIMEOUT - Resume with increased timeouts
 * 5. DEPENDENCY_FAILURE - Skip failed optional dependencies
 *
 * Usage:
 * ```typescript
 * const repairAgent = createRepairAgent();
 * 
 * const result = await repairAgent.analyzeAndRepair(zombieSaga);
 * 
 * if (result.repairSuccessful) {
 *   console.log(`Auto-repaired ${zombieSaga.executionId}`);
 * } else {
 *   console.log(`Escalated to human: ${result.escalationReason}`);
 * }
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { Redis } from "@upstash/redis";
import { getRedisClient, ServiceNamespace } from "../redis";
import { RealtimeService } from "../realtime";
import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { createSchemaVersioningService } from "./schema-versioning";
import { createShadowDryRunService } from "./shadow-dry-run";
import { createSemanticVersioningService } from "./semantic-versioning";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Zombie saga from DLQ
 */
export interface ZombieSaga {
  executionId: string;
  workflowId: string;
  intentId?: string;
  userId?: string;
  status: string;
  lastActivityAt: string;
  inactiveDurationMs: number;
  stepStates: Array<{
    step_id: string;
    status: string;
    error?: any;
    tool_name?: string;
    parameters?: Record<string, unknown>;
  }>;
  compensationsRegistered?: Array<{
    stepId: string;
    compensationTool: string;
    parameters: Record<string, unknown>;
  }>;
  requiresHumanIntervention: boolean;
  recoveryAttempts: number;
  failureContext?: {
    errorCode?: string;
    errorMessage?: string;
    failedStepIndex?: number;
    failedTool?: string;
  };
}

/**
 * Repair analysis result
 */
export interface RepairAnalysis {
  failureType: FailureType;
  confidence: number; // 0-1
  rootCause: string;
  suggestedFix: SuggestedFix;
  canAutoRepair: boolean;
  requiresHumanIntervention: boolean;
}

/**
 * Type of failure detected
 */
export type FailureType =
  | "PARAMETER_MISMATCH"
  | "TRANSIENT_ERROR"
  | "LOGIC_DRIFT"
  | "TIMEOUT"
  | "DEPENDENCY_FAILURE"
  | "COMPENSATION_FAILURE"
  | "UNKNOWN";

/**
 * Suggested fix payload
 */
export interface SuggestedFix {
  type: "ADAPT_PARAMETERS" | "RETRY_STEP" | "SKIP_STEP" | "UPDATE_TIMEOUT" | "MANUAL_REVIEW";
  description: string;
  parameters?: {
    stepIndex?: number;
    adaptedParams?: Record<string, unknown>;
    timeoutMs?: number;
  };
  confidence: number;
  reasoning: string;
}

/**
 * Repair execution result
 */
export interface RepairResult {
  success: boolean;
  action: "AUTO_REPAIRED" | "DRY_RUN_PASSED" | "ESCALATED" | "SKIPPED";
  executionId: string;
  repairAnalysis?: RepairAnalysis;
  dryRunResult?: {
    passed: boolean;
    divergencePercentage: number;
    warnings: string[];
  };
  escalationReason?: string;
  error?: string;
}

/**
 * LLM repair suggestion schema
 */
const RepairSuggestionSchema = z.object({
  failureType: z.enum([
    "PARAMETER_MISMATCH",
    "TRANSIENT_ERROR",
    "LOGIC_DRIFT",
    "TIMEOUT",
    "DEPENDENCY_FAILURE",
    "COMPENSATION_FAILURE",
    "UNKNOWN",
  ]),
  confidence: z.number().min(0).max(1),
  rootCause: z.string(),
  suggestedFix: z.object({
    type: z.enum([
      "ADAPT_PARAMETERS",
      "RETRY_STEP",
      "SKIP_STEP",
      "UPDATE_TIMEOUT",
      "MANUAL_REVIEW",
    ]),
    description: z.string(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
  }),
  canAutoRepair: z.boolean(),
  requiresHumanIntervention: z.boolean(),
});

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface RepairAgentConfig {
  redis: Redis;
  /** Maximum auto-repair attempts before escalation (default: 2) */
  maxAutoRepairAttempts: number;
  /** Minimum confidence threshold for auto-repair (default: 0.8) */
  minConfidenceThreshold: number;
  /** Enable shadow dry-run before applying fix (default: true) */
  enableShadowDryRun: boolean;
  /** LLM model for repair analysis */
  llmModel: any;
  /** Enable debug logging */
  debug: boolean;
}

const DEFAULT_CONFIG: Required<RepairAgentConfig> = {
  redis: null as any,
  maxAutoRepairAttempts: 2,
  minConfidenceThreshold: 0.8,
  enableShadowDryRun: true,
  llmModel: null as any,
  debug: false,
};

// ============================================================================
// REPAIR AGENT
// ============================================================================

export class RepairAgent {
  private config: Required<RepairAgentConfig>;
  private schemaVersioning: ReturnType<typeof createSchemaVersioningService>;
  private semanticVersioning: ReturnType<typeof createSemanticVersioningService>;
  private shadowDryRun: ReturnType<typeof createShadowDryRunService>;

  constructor(config: RepairAgentConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.schemaVersioning = createSchemaVersioningService({ redis: this.config.redis });
    this.semanticVersioning = createSemanticVersioningService({ redis: this.config.redis });
    this.shadowDryRun = createShadowDryRunService();
  }

  /**
   * Analyze and attempt to repair a zombie saga
   *
   * @param zombie - Zombie saga from DLQ
   * @returns Repair result
   */
  async analyzeAndRepair(zombie: ZombieSaga): Promise<RepairResult> {
    try {
      if (this.config.debug) {
        console.log(`[RepairAgent] Analyzing zombie saga ${zombie.executionId}`);
      }

      // Step 1: Analyze failure
      const analysis = await this.analyzeFailure(zombie);

      if (this.config.debug) {
        console.log(
          `[RepairAgent] Analysis complete: ${analysis.failureType} ` +
          `(confidence: ${analysis.confidence.toFixed(2)}, canRepair: ${analysis.canAutoRepair})`
        );
      }

      // Step 2: Check if auto-repair is possible
      if (!analysis.canAutoRepair || analysis.requiresHumanIntervention) {
        return await this.escalateToHuman(zombie, analysis);
      }

      // Step 3: Check confidence threshold
      if (analysis.confidence < this.config.minConfidenceThreshold) {
        if (this.config.debug) {
          console.log(
            `[RepairAgent] Confidence ${analysis.confidence.toFixed(2)} ` +
            `below threshold ${this.config.minConfidenceThreshold}`
          );
        }
        return await this.escalateToHuman(zombie, analysis);
      }

      // Step 4: Check max auto-repair attempts
      if (zombie.recoveryAttempts >= this.config.maxAutoRepairAttempts) {
        return await this.escalateToHuman(
          zombie,
          analysis,
          `Max auto-repair attempts exceeded (${this.config.maxAutoRepairAttempts})`
        );
      }

      // Step 5: Apply fix (with shadow dry-run if enabled)
      if (this.config.enableShadowDryRun) {
        const dryRunResult = await this.testFixWithDryRun(zombie, analysis);
        
        if (!dryRunResult.passed) {
          return await this.escalateToHuman(
            zombie,
            analysis,
            `Shadow dry-run failed: ${dryRunResult.divergencePercentage.toFixed(1)}% divergence`
          );
        }

        // Dry-run passed - apply fix
        return await this.applyFixAndResume(zombie, analysis, dryRunResult);
      } else {
        // Skip dry-run, apply fix directly
        return await this.applyFixAndResume(zombie, analysis);
      }
    } catch (error) {
      console.error(`[RepairAgent] Repair failed for ${zombie.executionId}:`, error);
      return {
        success: false,
        action: "ESCALATED",
        executionId: zombie.executionId,
        escalationReason: `Repair agent error: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Analyze failure using LLM-powered diagnosis
   */
  private async analyzeFailure(zombie: ZombieSaga): Promise<RepairAnalysis> {
    // Build failure context
    const failureContext = this.buildFailureContext(zombie);

    // Use LLM to diagnose and suggest fix
    const { object } = await generateObject({
      model: this.config.llmModel || openai("gpt-4o-mini"),
      schema: RepairSuggestionSchema,
      prompt: this.buildAnalysisPrompt(failureContext),
      system: `You are an expert distributed systems debugger specializing in saga pattern failures.
Analyze the failure context and diagnose the root cause.
Be conservative - if unsure, recommend human intervention.
Auto-repair is only safe for clear, fixable issues like parameter mismatches or transient errors.`,
    });

    return object;
  }

  /**
   * Build failure context for LLM analysis
   */
  private buildFailureContext(zombie: ZombieSaga): string {
    const failedStep = zombie.stepStates.find(s => s.status === "failed");
    
    const context = `
## Zombie Saga Context
- Execution ID: ${zombie.executionId}
- Workflow ID: ${zombie.workflowId}
- Status: ${zombie.status}
- Inactive Duration: ${zombie.inactiveDurationMs / 1000}s
- Recovery Attempts: ${zombie.recoveryAttempts}

## Failed Step
${failedStep ? `
- Step ID: ${failedStep.step_id}
- Tool: ${failedStep.tool_name || "unknown"}
- Error: ${JSON.stringify(failedStep.error, null, 2)}
- Parameters: ${JSON.stringify(failedStep.parameters || {}, null, 2)}
` : "No failed step identified"}

## Step States
${zombie.stepStates.map((s, i) => 
  `${i}. ${s.step_id} (${s.tool_name || "unknown"}): ${s.status}${s.error ? ` [${JSON.stringify(s.error)}]` : ""}`
).join("\n")}

## Compensations Registered
${zombie.compensationsRegistered?.length || 0} compensations:
${(zombie.compensationsRegistered || []).map((c, i) => 
  `${i}. ${c.compensationTool}: ${JSON.stringify(c.parameters)}`
).join("\n")}
`;

    return context;
  }

  /**
   * Build analysis prompt for LLM
   */
  private buildAnalysisPrompt(context: string): string {
    return `
${context}

## Task
Diagnose the root cause of this saga failure and suggest a repair strategy.

## Failure Types
- PARAMETER_MISMATCH: Tool parameters don't match current schema (fixable with adapter)
- TRANSIENT_ERROR: Temporary failure like network timeout, rate limit (fixable with retry)
- LOGIC_DRIFT: Code deployment changed behavior between checkpoint and resume (may need parameter mapping)
- TIMEOUT: Step or saga exceeded timeout (fixable with timeout increase)
- DEPENDENCY_FAILURE: External service failed (may be skippable if optional)
- COMPENSATION_FAILURE: Compensation step failed (may need retry with different params)
- UNKNOWN: Cannot determine cause (requires human)

## Repair Strategies
- ADAPT_PARAMETERS: Use semantic versioning to adapt old parameters to new schema
- RETRY_STEP: Retry the failed step with exponential backoff
- SKIP_STEP: Skip the failed step if it's optional
- UPDATE_TIMEOUT: Increase timeout and resume
- MANUAL_REVIEW: Cannot auto-repair, needs human intervention

## Output Requirements
1. Be conservative - prefer human intervention when uncertain
2. Auto-repair only when the fix is clearly safe
3. Provide detailed reasoning for your diagnosis
4. Confidence should reflect certainty (0.5 = guessing, 0.9+ = very confident)
`;
  }

  /**
   * Test fix using shadow dry-run
   */
  private async testFixWithDryRun(
    zombie: ZombieSaga,
    analysis: RepairAnalysis
  ): Promise<{
    passed: boolean;
    divergencePercentage: number;
    warnings: string[];
  }> {
    try {
      // Capture current state snapshot
      const stateSnapshot = await this.captureStateSnapshot(zombie);
      
      if (!stateSnapshot) {
        throw new Error("Failed to capture state snapshot");
      }

      // Get checkpoint metadata
      const checkpointMetadata = await this.schemaVersioning.getCheckpointMetadata(zombie.executionId);

      // Execute shadow dry-run
      const dryRunResult = await this.shadowDryRun.executeDryRun({
        executionId: zombie.executionId,
        // Pass modified state with suggested fix applied
        stateSnapshot: {
          ...stateSnapshot,
          context: {
            ...stateSnapshot.context,
            repairAttempt: {
              analysis,
              timestamp: new Date().toISOString(),
            },
          },
        },
        plan: stateSnapshot.plan,
        checkpointMetadata: checkpointMetadata || {},
        currentMetadata: {
          orchestratorGitSha: process.env.VERCEL_GIT_COMMIT_SHA || "unknown",
          toolVersions: {},
        },
      });

      return {
        passed: dryRunResult.recommendation !== "BLOCK_RESUME",
        divergencePercentage: dryRunResult.divergencePercentage,
        warnings: dryRunResult.warnings || [],
      };
    } catch (error) {
      console.error(`[RepairAgent] Shadow dry-run failed:`, error);
      return {
        passed: false,
        divergencePercentage: 100,
        warnings: [`Shadow dry-run error: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }

  /**
   * Capture state snapshot for dry-run
   */
  private async captureStateSnapshot(zombie: ZombieSaga): Promise<any> {
    const key = `intentionengine:task:${zombie.executionId}`;
    const data = await this.config.redis.get<any>(key);
    
    if (!data) return null;
    
    const taskState = typeof data === "string" ? JSON.parse(data) : data;
    return taskState.context?.execution_state || null;
  }

  /**
   * Apply fix and resume saga
   */
  private async applyFixAndResume(
    zombie: ZombieSaga,
    analysis: RepairAnalysis,
    dryRunResult?: { passed: boolean; divergencePercentage: number; warnings: string[] }
  ): Promise<RepairResult> {
    try {
      // Increment recovery attempts
      const newRecoveryAttempts = zombie.recoveryAttempts + 1;

      // Store repair metadata
      const dlqKey = `dlq:saga:${zombie.executionId}`;
      await this.config.redis.setex(dlqKey, 86400 * 7, {
        executionId: zombie.executionId,
        workflowId: zombie.workflowId,
        detectedAt: new Date().toISOString(),
        recoveryAttempts: newRecoveryAttempts,
        lastRecoveryAttempt: new Date().toISOString(),
        status: zombie.status,
        reason: "AUTO_REPAIR",
        repairAnalysis: analysis,
        dryRunResult,
      });

      // Apply fix based on type
      let resumePayload: Record<string, unknown> = {};
      
      switch (analysis.suggestedFix.type) {
        case "ADAPT_PARAMETERS":
          resumePayload = {
            adaptedParameters: analysis.suggestedFix.parameters,
            repairType: "PARAMETER_ADAPTATION",
          };
          break;
        case "RETRY_STEP":
          resumePayload = {
            retryStepIndex: analysis.suggestedFix.parameters?.stepIndex,
            repairType: "RETRY",
          };
          break;
        case "SKIP_STEP":
          resumePayload = {
            skipStepIndex: analysis.suggestedFix.parameters?.stepIndex,
            repairType: "SKIP",
          };
          break;
        case "UPDATE_TIMEOUT":
          resumePayload = {
            timeoutMultiplier: 2,
            repairType: "TIMEOUT_INCREASE",
          };
          break;
      }

      // Publish WORKFLOW_RESUME event with fix payload
      await RealtimeService.publishNervousSystemEvent(
        "WORKFLOW_RESUME",
        {
          executionId: zombie.executionId,
          workflowId: zombie.workflowId,
          intentId: zombie.intentId,
          reason: "AUTO_REPAIR",
          recoveryAttempt: newRecoveryAttempts,
          repairAnalysis: analysis,
          fixPayload: resumePayload,
          timestamp: new Date().toISOString(),
        },
        undefined
      );

      console.log(
        `[RepairAgent] Auto-repaired zombie saga ${zombie.executionId} ` +
        `(${analysis.failureType}, confidence: ${analysis.confidence.toFixed(2)})`
      );

      return {
        success: true,
        action: "AUTO_REPAIRED",
        executionId: zombie.executionId,
        repairAnalysis: analysis,
        dryRunResult: dryRunResult ? {
          passed: dryRunResult.passed,
          divergencePercentage: dryRunResult.divergencePercentage,
          warnings: dryRunResult.warnings,
        } : undefined,
      };
    } catch (error) {
      console.error(`[RepairAgent] Failed to apply fix:`, error);
      return await this.escalateToHuman(
        zombie,
        analysis,
        `Failed to apply fix: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Escalate to human intervention
   */
  private async escalateToHuman(
    zombie: ZombieSaga,
    analysis: RepairAnalysis,
    additionalReason?: string
  ): Promise<RepairResult> {
    try {
      // Store escalation metadata
      const dlqKey = `dlq:saga:${zombie.executionId}`;
      await this.config.redis.setex(dlqKey, 86400 * 7, {
        executionId: zombie.executionId,
        workflowId: zombie.workflowId,
        detectedAt: new Date().toISOString(),
        recoveryAttempts: zombie.recoveryAttempts,
        status: zombie.status,
        reason: "ESCALATED_TO_HUMAN",
        repairAnalysis: analysis,
        escalationReason: additionalReason || analysis.rootCause,
        escalatedAt: new Date().toISOString(),
      });

      // Publish alert
      await RealtimeService.publish('system:alerts', 'saga_repair_escalated', {
        executionId: zombie.executionId,
        workflowId: zombie.workflowId,
        intentId: zombie.intentId,
        userId: zombie.userId,
        failureType: analysis.failureType,
        rootCause: analysis.rootCause,
        suggestedFix: analysis.suggestedFix,
        escalationReason: additionalReason || "Auto-repair not possible",
        severity: analysis.requiresHumanIntervention ? "CRITICAL" : "HIGH",
        requiresAction: true,
        timestamp: new Date().toISOString(),
      });

      // Publish to nervous system
      await RealtimeService.publishNervousSystemEvent(
        "SAGA_MANUAL_INTERVENTION_REQUIRED",
        {
          executionId: zombie.executionId,
          workflowId: zombie.workflowId,
          intentId: zombie.intentId,
          reason: "REPAIR_AGENT_ESCALATION",
          failureType: analysis.failureType,
          rootCause: analysis.rootCause,
          suggestedFix: analysis.suggestedFix,
          escalationReason: additionalReason,
          timestamp: new Date().toISOString(),
        },
        undefined
      );

      console.warn(
        `[RepairAgent] Escalated zombie saga ${zombie.executionId} to human: ` +
        `${additionalReason || analysis.rootCause}`
      );

      return {
        success: false,
        action: "ESCALATED",
        executionId: zombie.executionId,
        repairAnalysis: analysis,
        escalationReason: additionalReason || analysis.rootCause,
      };
    } catch (error) {
      console.error(`[RepairAgent] Failed to escalate:`, error);
      return {
        success: false,
        action: "ESCALATED",
        executionId: zombie.executionId,
        escalationReason: `Failed to escalate: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createRepairAgent(options?: {
  redis?: Redis;
  maxAutoRepairAttempts?: number;
  minConfidenceThreshold?: number;
  enableShadowDryRun?: boolean;
  debug?: boolean;
}): RepairAgent {
  const redis = options?.redis || getRedisClient(ServiceNamespace.SHARED);

  return new RepairAgent({
    redis,
    maxAutoRepairAttempts: options?.maxAutoRepairAttempts || 2,
    minConfidenceThreshold: options?.minConfidenceThreshold || 0.8,
    enableShadowDryRun: options?.enableShadowDryRun !== false,
    llmModel: openai("gpt-4o-mini"),
    debug: options?.debug || false,
  });
}

// ============================================================================
// TYPE EXPORTS
// ============================================================================
