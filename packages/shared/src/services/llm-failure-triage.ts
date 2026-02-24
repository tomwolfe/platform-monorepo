/**
 * LLM-Powered Failure Triage Service
 *
 * Replaces brittle string-matching logic with semantic understanding of tool failures.
 * Uses a fast, cheap LLM (GPT-4o-mini) to categorize failures into structured enums
 * for precise failover policy triggering.
 *
 * Features:
 * - Semantic error analysis (not regex-based)
 * - Structured output via Zod schema
 * - Recoverability assessment
 * - Cost-optimized with fallback to heuristic analysis
 *
 * @since 1.1.0
 */

import { z } from "zod";

// AI SDK types (dynamically imported when needed)
type GenerateObjectFn = (options: any) => Promise<any>;
type OpenAIProvider = (modelId: string) => any;

// ============================================================================
// FAILURE REASON SCHEMA
// Structured categorization of tool failures
// ============================================================================

export const FailureReasonSchema = z.enum([
  // Availability failures
  "RESTAURANT_FULL",
  "TABLE_UNAVAILABLE",
  "TIME_SLOT_UNAVAILABLE",
  "DELIVERY_UNAVAILABLE",
  
  // Capacity failures
  "KITCHEN_OVERLOADED",
  "PARTY_SIZE_TOO_LARGE",
  
  // Technical failures
  "SERVICE_ERROR",
  "TIMEOUT",
  "RATE_LIMITED",
  "CONNECTION_ERROR",
  
  // Business logic failures
  "PAYMENT_FAILED",
  "VALIDATION_FAILED",
  "SCHEMA_MISMATCH",
  "USER_ERROR",
  
  // External dependencies
  "UPSTREAM_FLAKINESS",
  "THIRD_PARTY_ERROR",
  
  // Unknown/unrecoverable
  "UNKNOWN",
  "UNRECOVERABLE",
]);

export type FailureReason = z.infer<typeof FailureReasonSchema>;

/**
 * Triage result from LLM analysis
 */
export const TriageResultSchema = z.object({
  category: FailureReasonSchema,
  isRecoverable: z.boolean(),
  confidence: z.number().min(0).max(1),
  explanation: z.string(),
  suggestedAction: z.enum([
    "RETRY_WITH_MODIFIED_PARAMS",
    "RETRY_WITH_BACKOFF",
    "ESCALATE_TO_HUMAN",
    "SKIP_STEP",
    "TRIGGER_COMPENSATION",
  ]).optional(),
});

export type TriageResult = z.infer<typeof TriageResultSchema>;

/**
 * Context for failure triage
 */
export interface TriageContext {
  error: string;
  toolName: string;
  toolDescription?: string;
  parameters?: Record<string, unknown>;
  errorCode?: number;
  errorType?: string;
  stackTrace?: string;
  timestamp?: string;
}

// ============================================================================
// TRIAGE MODEL CONFIGURATION
// Optimized for speed and cost
// ============================================================================

interface TriageModelConfig {
  model?: any;
  temperature: number;
  maxTokens: number;
}

const TRIAGE_MODEL_CONFIG: TriageModelConfig = {
  temperature: 0, // Deterministic output
  maxTokens: 300,
};

/**
 * Prompt template for failure triage
 */
function buildTriagePrompt(context: TriageContext): string {
  const parts = [
    "Analyze this tool execution failure and categorize it.",
    "",
    `## Tool Information`,
    `- Name: ${context.toolName}`,
    context.toolDescription ? `- Description: ${context.toolDescription}` : "",
    "",
    `## Error Details`,
    `- Error Message: ${context.error}`,
    context.errorCode ? `- Error Code: ${context.errorCode}` : "",
    context.errorType ? `- Error Type: ${context.errorType}` : "",
    "",
    context.parameters ? `## Parameters\n${JSON.stringify(context.parameters, null, 2)}` : "",
    "",
    "Categorize the failure into one of the predefined categories.",
    "Assess whether it's recoverable via retry or parameter modification.",
    "",
    "## Categories:",
    "- RESTAURANT_FULL: No availability, fully booked",
    "- TABLE_UNAVAILABLE: Specific table not available",
    "- TIME_SLOT_UNAVAILABLE: Requested time slot not available",
    "- DELIVERY_UNAVAILABLE: Delivery service not available",
    "- KITCHEN_OVERLOADED: High volume, overload, busy",
    "- PARTY_SIZE_TOO_LARGE: Group exceeds capacity",
    "- SERVICE_ERROR: 5xx errors, internal errors",
    "- TIMEOUT: Request timeout",
    "- RATE_LIMITED: Too many requests",
    "- CONNECTION_ERROR: Network connectivity issues",
    "- PAYMENT_FAILED: Payment processing errors",
    "- VALIDATION_FAILED: Input validation errors",
    "- SCHEMA_MISMATCH: Parameter schema mismatch",
    "- USER_ERROR: Invalid user input",
    "- UPSTREAM_FLAKINESS: Transient external service issues",
    "- THIRD_PARTY_ERROR: External API errors",
    "- UNKNOWN: Unclassified error",
    "- UNRECOVERABLE: Cannot be recovered",
  ];

  return parts.filter(Boolean).join("\n");
}

// ============================================================================
// TRIAGE SERVICE
// ============================================================================

export interface FailureTriageService {
  /**
   * Analyze a tool failure using LLM-powered semantic triage
   */
  triageFailure(context: TriageContext): Promise<TriageResult>;

  /**
   * Batch triage multiple failures (cost-optimized)
   */
  triageBatch(contexts: TriageContext[]): Promise<TriageResult[]>;

  /**
   * Check if a failure reason is recoverable
   */
  isRecoverable(reason: FailureReason): boolean;

  /**
   * Get suggested action for a failure reason
   */
  getSuggestedAction(reason: FailureReason): TriageResult["suggestedAction"];
}

export class LLMFailureTriageService implements FailureTriageService {
  private enabled: boolean;
  private fallbackToHeuristics: boolean;
  private generateObjectFn?: GenerateObjectFn;
  private openaiProvider?: OpenAIProvider;

  constructor(options?: { 
    enabled?: boolean; 
    fallbackToHeuristics?: boolean;
    generateObjectFn?: GenerateObjectFn;
    openaiProvider?: OpenAIProvider;
  }) {
    this.enabled = options?.enabled ?? true;
    this.fallbackToHeuristics = options?.fallbackToHeuristics ?? true;
    this.generateObjectFn = options?.generateObjectFn;
    this.openaiProvider = options?.openaiProvider;
  }

  /**
   * Analyze a tool failure using LLM-powered semantic triage
   */
  async triageFailure(context: TriageContext): Promise<TriageResult> {
    // Try LLM triage if enabled and SDK is available
    if (this.enabled && this.generateObjectFn && this.openaiProvider) {
      try {
        const model = this.openaiProvider("gpt-4o-mini");
        const prompt = buildTriagePrompt(context);

        const result = await this.generateObjectFn({
          ...TRIAGE_MODEL_CONFIG,
          model,
          schema: TriageResultSchema,
          prompt,
        });

        return result.object;
      } catch (error) {
        console.error("[LLMFailureTriage] LLM triage failed, falling back to heuristics:", error);
      }
    }

    // Fallback to heuristics
    if (this.fallbackToHeuristics) {
      return this.heuristicTriage(context);
    }

    // Return conservative default
    return {
      category: "UNKNOWN" as FailureReason,
      isRecoverable: false,
      confidence: 0.0,
      explanation: "LLM triage unavailable and heuristics disabled",
    };
  }

  /**
   * Batch triage multiple failures (cost-optimized)
   * Note: Currently processes sequentially, but can be optimized for batch LLM calls
   */
  async triageBatch(contexts: TriageContext[]): Promise<TriageResult[]> {
    const results: TriageResult[] = [];

    for (const context of contexts) {
      results.push(await this.triageFailure(context));
    }

    return results;
  }

  /**
   * Fallback heuristic-based triage (preserves existing logic)
   */
  private heuristicTriage(context: TriageContext): TriageResult {
    const errorLower = context.error.toLowerCase();
    const { errorCode } = context;

    // Availability failures
    if (errorLower.includes("full") || errorLower.includes("no availability") || errorLower.includes("fully booked")) {
      return {
        category: "RESTAURANT_FULL",
        isRecoverable: true,
        confidence: 0.9,
        explanation: "Restaurant has no availability",
        suggestedAction: "RETRY_WITH_MODIFIED_PARAMS",
      };
    }

    if (errorLower.includes("unavailable") || errorLower.includes("not available")) {
      if (errorLower.includes("delivery")) {
        return {
          category: "DELIVERY_UNAVAILABLE",
          isRecoverable: true,
          confidence: 0.85,
          explanation: "Delivery service not available",
          suggestedAction: "RETRY_WITH_MODIFIED_PARAMS",
        };
      }
      if (errorLower.includes("table")) {
        return {
          category: "TABLE_UNAVAILABLE",
          isRecoverable: true,
          confidence: 0.85,
          explanation: "Table not available",
          suggestedAction: "RETRY_WITH_MODIFIED_PARAMS",
        };
      }
      if (errorLower.includes("time")) {
        return {
          category: "TIME_SLOT_UNAVAILABLE",
          isRecoverable: true,
          confidence: 0.85,
          explanation: "Time slot not available",
          suggestedAction: "RETRY_WITH_MODIFIED_PARAMS",
        };
      }
    }

    // Capacity failures
    if (errorLower.includes("overload") || errorLower.includes("busy") || errorLower.includes("high volume")) {
      return {
        category: "KITCHEN_OVERLOADED",
        isRecoverable: true,
        confidence: 0.8,
        explanation: "Kitchen is overloaded",
        suggestedAction: "RETRY_WITH_BACKOFF",
      };
    }

    if (errorLower.includes("party size") || errorLower.includes("too large") || errorLower.includes("exceeds")) {
      return {
        category: "PARTY_SIZE_TOO_LARGE",
        isRecoverable: false,
        confidence: 0.95,
        explanation: "Party size exceeds capacity",
        suggestedAction: "ESCALATE_TO_HUMAN",
      };
    }

    // Technical failures
    if (errorCode && errorCode >= 500) {
      return {
        category: "SERVICE_ERROR",
        isRecoverable: true,
        confidence: 0.7,
        explanation: "Server error occurred",
        suggestedAction: "RETRY_WITH_BACKOFF",
      };
    }

    if (errorLower.includes("timeout")) {
      return {
        category: "TIMEOUT",
        isRecoverable: true,
        confidence: 0.9,
        explanation: "Request timed out",
        suggestedAction: "RETRY_WITH_BACKOFF",
      };
    }

    if (errorCode && errorCode === 429) {
      return {
        category: "RATE_LIMITED",
        isRecoverable: true,
        confidence: 0.95,
        explanation: "Rate limit exceeded",
        suggestedAction: "RETRY_WITH_BACKOFF",
      };
    }

    if (errorLower.includes("connection") || errorLower.includes("network") || errorLower.includes("fetch")) {
      return {
        category: "CONNECTION_ERROR",
        isRecoverable: true,
        confidence: 0.8,
        explanation: "Network connectivity issue",
        suggestedAction: "RETRY_WITH_BACKOFF",
      };
    }

    // Business logic failures
    if (errorLower.includes("payment") || errorLower.includes("card") || errorLower.includes("charge")) {
      return {
        category: "PAYMENT_FAILED",
        isRecoverable: true,
        confidence: 0.85,
        explanation: "Payment processing failed",
        suggestedAction: "ESCALATE_TO_HUMAN",
      };
    }

    if (errorLower.includes("invalid") || errorLower.includes("validation")) {
      if (errorLower.includes("schema") || errorLower.includes("parameter")) {
        return {
          category: "SCHEMA_MISMATCH",
          isRecoverable: true,
          confidence: 0.9,
          explanation: "Parameter schema mismatch",
          suggestedAction: "RETRY_WITH_MODIFIED_PARAMS",
        };
      }
      return {
        category: "VALIDATION_FAILED",
        isRecoverable: true,
        confidence: 0.85,
        explanation: "Input validation failed",
        suggestedAction: "RETRY_WITH_MODIFIED_PARAMS",
      };
    }

    if (errorLower.includes("user")) {
      return {
        category: "USER_ERROR",
        isRecoverable: false,
        confidence: 0.7,
        explanation: "User input error",
        suggestedAction: "ESCALATE_TO_HUMAN",
      };
    }

    // Upstream issues
    if (errorLower.includes("upstream") || errorLower.includes("external") || errorLower.includes("third party")) {
      return {
        category: "UPSTREAM_FLAKINESS",
        isRecoverable: true,
        confidence: 0.6,
        explanation: "Upstream service issue",
        suggestedAction: "RETRY_WITH_BACKOFF",
      };
    }

    // Unknown
    return {
      category: "UNKNOWN",
      isRecoverable: false,
      confidence: 0.3,
      explanation: "Unable to categorize error",
      suggestedAction: "ESCALATE_TO_HUMAN",
    };
  }

  /**
   * Check if a failure reason is recoverable
   */
  isRecoverable(reason: FailureReason): boolean {
    const recoverableReasons: FailureReason[] = [
      "RESTAURANT_FULL",
      "TABLE_UNAVAILABLE",
      "TIME_SLOT_UNAVAILABLE",
      "KITCHEN_OVERLOADED",
      "SERVICE_ERROR",
      "TIMEOUT",
      "RATE_LIMITED",
      "CONNECTION_ERROR",
      "VALIDATION_FAILED",
      "SCHEMA_MISMATCH",
      "UPSTREAM_FLAKINESS",
    ];

    return recoverableReasons.includes(reason);
  }

  /**
   * Get suggested action for a failure reason
   */
  getSuggestedAction(reason: FailureReason): TriageResult["suggestedAction"] {
    const actionMap: Record<FailureReason, TriageResult["suggestedAction"]> = {
      // Retry with modified parameters
      RESTAURANT_FULL: "RETRY_WITH_MODIFIED_PARAMS",
      TABLE_UNAVAILABLE: "RETRY_WITH_MODIFIED_PARAMS",
      TIME_SLOT_UNAVAILABLE: "RETRY_WITH_MODIFIED_PARAMS",
      DELIVERY_UNAVAILABLE: "RETRY_WITH_MODIFIED_PARAMS",
      SCHEMA_MISMATCH: "RETRY_WITH_MODIFIED_PARAMS",
      VALIDATION_FAILED: "RETRY_WITH_MODIFIED_PARAMS",
      USER_ERROR: "RETRY_WITH_MODIFIED_PARAMS",

      // Retry with backoff
      KITCHEN_OVERLOADED: "RETRY_WITH_BACKOFF",
      SERVICE_ERROR: "RETRY_WITH_BACKOFF",
      TIMEOUT: "RETRY_WITH_BACKOFF",
      RATE_LIMITED: "RETRY_WITH_BACKOFF",
      CONNECTION_ERROR: "RETRY_WITH_BACKOFF",
      UPSTREAM_FLAKINESS: "RETRY_WITH_BACKOFF",
      THIRD_PARTY_ERROR: "RETRY_WITH_BACKOFF",

      // Escalate to human
      PAYMENT_FAILED: "ESCALATE_TO_HUMAN",
      PARTY_SIZE_TOO_LARGE: "ESCALATE_TO_HUMAN",
      UNKNOWN: "ESCALATE_TO_HUMAN",
      UNRECOVERABLE: "ESCALATE_TO_HUMAN",
    };

    return actionMap[reason] || "ESCALATE_TO_HUMAN";
  }
}

// ============================================================================
// SINGLETON
// ============================================================================

let defaultTriageService: LLMFailureTriageService | null = null;

export function getLLMFailureTriageService(options?: {
  generateObjectFn?: GenerateObjectFn;
  openaiProvider?: OpenAIProvider;
}): LLMFailureTriageService {
  if (!defaultTriageService) {
    defaultTriageService = new LLMFailureTriageService({
      generateObjectFn: options?.generateObjectFn,
      openaiProvider: options?.openaiProvider,
    });
  }
  return defaultTriageService;
}

export function createLLMFailureTriageService(options?: {
  enabled?: boolean;
  fallbackToHeuristics?: boolean;
  generateObjectFn?: GenerateObjectFn;
  openaiProvider?: OpenAIProvider;
}): LLMFailureTriageService {
  return new LLMFailureTriageService({
    enabled: options?.enabled,
    fallbackToHeuristics: options?.fallbackToHeuristics,
    generateObjectFn: options?.generateObjectFn,
    openaiProvider: options?.openaiProvider,
  });
}
