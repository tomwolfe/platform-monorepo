/**
 * Chat Orchestrator Service
 *
 * Encapsulates the business logic for chat request orchestration:
 * - Prompt injection detection
 * - Live operational state hydration
 * - Intent inference and normalization
 * - Async execution triggering for Saga operations
 *
 * This service extracts business logic from the God Chat Route,
 * making it more testable and maintainable.
 *
 * @package @repo/intention-engine
 * @since 1.0.0
 */

import { randomUUID } from "crypto";
import { z } from "zod";
import {
  promptInjectionMiddleware,
  type DetectionResult,
} from "@/lib/middleware/prompt-injection";
import {
  fetchLiveOperationalState,
  type LiveOperationalStateResult,
} from "./live-state";
import { inferIntent, type IntentInferenceResult } from "./intent";
import { NormalizationService } from "@/lib/normalization";
import { createInitialState, setIntent, setPlan } from "./state-machine";
import { saveExecutionState } from "./memory";
import { generatePlan } from "./unified-planner";
import { getRegistryManager } from "./registry";
import { Logger } from "@repo/shared";

const logger = new Logger({ serviceName: "intention-engine" });
import { verifyPlan, DEFAULT_SAFETY_POLICY } from "./verifier";
import { QStashService } from "@repo/shared";
import { type Intent } from "./types";

// ============================================================================
// TYPES
// ============================================================================

export interface UserContext {
  userId: string;
  clerkId?: string;
  userEmail?: string;
  userIp: string;
}

export interface UserLocation {
  lat: number;
  lng: number;
}

export interface ChatOrchestrationRequest {
  messages: unknown[];
  userLocation?: UserLocation;
  userContext: UserContext;
}

export interface ChatOrchestrationResult {
  intent: Intent;
  auditLogId: string;
  executionId?: string;
  requiresAsyncExecution: boolean;
  liveOperationalState?: LiveOperationalStateResult;
}

export interface SecurityCheckResult {
  allowed: boolean;
  detectionResult: DetectionResult;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Intent types that require saga-style async execution
 * These are multi-step, state-modifying operations
 */
const SAGA_INTENT_TYPES = [
  "BOOKING",
  "RESERVATION",
  "CREATE_RESERVATION",
  "BOOK_RESTAURANT",
  "RESERVE_RESTAURANT",
  "CREATE_ORDER",
  "PLACE_ORDER",
  "CHECKOUT",
  "PURCHASE",
  "DISPATCH",
  "DELIVERY",
  "CREATE_DELIVERY",
  "SEND_COMM",
  "SEND_EMAIL",
  "SEND_SMS",
  "ADD_CALENDAR_EVENT",
  "CREATE_EVENT",
  "PAYMENT",
  "PROCESS_PAYMENT",
  "REFUND",
  "REQUEST_RIDE",
  "MOBILITY",
] as const;

// ============================================================================
// CHAT ORCHESTRATOR SERVICE
// ============================================================================

export class ChatOrchestratorService {
  private userContext: UserContext = {} as UserContext;
  private readonly internalSystemKey: string;

  constructor(internalSystemKey: string, userContext: UserContext) {
    this.internalSystemKey = internalSystemKey;
    this.userContext = userContext;
  }

  /**
   * Check if an intent requires saga-style async execution
   */
  requiresSagaExecution(intentType: string): boolean {
    return SAGA_INTENT_TYPES.some(
      (type) => intentType.includes(type) || intentType === type,
    );
  }

  /**
   * SECURITY: Prompt Injection Detection
   * Scans user input for prompt injection attacks before processing
   */
  async checkSecurity(userText: string): Promise<SecurityCheckResult> {
    const securityCheck = await promptInjectionMiddleware(
      userText,
      this.userContext.userId,
      {
        enableHeuristics: true,
        enableSemanticAnalysis: true,
        enableEncodingDetection: true,
        enableAuditLog: true,
      },
    );

    return {
      allowed: securityCheck.allowed,
      detectionResult: securityCheck.detectionResult,
    };
  }

  /**
   * Infer and normalize intent from user text
   */
  async inferIntent(
    userText: string,
    avoidTools: string[],
    history: Array<{
      intentType: string;
      rawText: string;
      parameters: Record<string, unknown>;
    }>,
    lastInteractionContext?: {
      intentType?: string;
      rawText?: string;
      parameters?: Record<string, unknown>;
      timestamp?: string;
    } | null,
  ): Promise<IntentInferenceResult & { intent: Intent }> {
    const inferenceResult = await inferIntent(
      userText,
      avoidTools,
      history,
      lastInteractionContext || undefined,
      this.userContext.clerkId || undefined,
    );

    const intent = inferenceResult.hypotheses.primary;

    // Normalize intent parameters against schemas
    const normalizationResult = NormalizationService.normalizeIntentParameters(
      intent.type,
      intent.parameters || {},
    );

    if (!normalizationResult.success) {
      logger.warn({
        message: "[NormalizationService] Intent parameter validation failed",
        error: JSON.stringify({
          intentType: intent.type,
          errors: normalizationResult.errors,
        }),
      });
      // Reduce confidence if parameters fail validation
      intent.confidence = Math.min(intent.confidence * 0.5, 0.3);
    } else if (normalizationResult.data) {
      // Replace parameters with normalized/validated version
      intent.parameters = normalizationResult.data as Record<string, unknown>;
    }

    return {
      ...inferenceResult,
      intent,
    };
  }

  /**
   * Fetch live operational state for zero-latency context
   */
  async fetchLiveState(
    coreMessages: unknown[],
    userLocation?: UserLocation,
    intentContext?: {
      intentType?: string;
      partySize?: number;
      requestedTime?: string;
      restaurantId?: string;
    },
  ): Promise<LiveOperationalStateResult> {
    return fetchLiveOperationalState(coreMessages, userLocation || undefined, {
      intentType: intentContext?.intentType,
      partySize: intentContext?.partySize,
      requestedTime: intentContext?.requestedTime,
      restaurantId: intentContext?.restaurantId,
    });
  }

  /**
   * Trigger async execution for saga-type operations
   *
   * Creates an execution state and triggers QStash to run the plan
   * asynchronously using the recursive self-trigger pattern.
   *
   * @param intent - The parsed intent
   * @param auditLogId - Audit log ID for tracing
   * @returns Execution ID for tracking
   */
  async triggerAsyncExecution(
    intent: Intent,
    auditLogId: string,
  ): Promise<string> {
    const executionId = randomUUID();

    try {
      // Create initial state
      let state = createInitialState(executionId);
      state = setIntent(state, intent);

      // Generate plan
      const registryManager = getRegistryManager();
      const planResult = await generatePlan(intent, {
        execution_id: executionId,
        available_tools: registryManager.listAllTools(),
      });

      // Verify plan
      const verification = verifyPlan(planResult.plan, DEFAULT_SAFETY_POLICY);
      if (!verification.valid) {
        throw new Error(verification.reason || "Plan verification failed");
      }

      state = setPlan(state, planResult.plan);
      await saveExecutionState(state);

      // Trigger first step via QStash
      // CRITICAL: Pass trace context for distributed tracing
      await QStashService.triggerNextStep({
        executionId,
        stepIndex: 0,
        internalKey: this.internalSystemKey,
        traceId: executionId, // Use executionId as initial traceId
        correlationId: executionId,
      });

      logger.info({
        message: `[ChatOrchestrator] Triggered async execution ${executionId} for intent ${intent.type} [trace: ${executionId}]`,
      });

      return executionId;
    } catch (error) {
      logger.error({
        message: "[ChatOrchestrator] Failed to trigger async execution",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Main orchestration method
   *
   * Coordinates the full chat request lifecycle:
   * 1. Security check (prompt injection)
   * 2. Intent inference
   * 3. Live state hydration
   * 4. Async execution triggering (if needed)
   *
   * @param request - Orchestration request
   * @param userText - Extracted user text from messages
   * @param coreMessages - Core messages for live state fetch
   * @param avoidTools - Tools to avoid (from user preferences)
   * @param history - Recent successful intents for context
   * @param lastInteractionContext - Last interaction context for pronoun resolution
   * @returns Orchestration result
   */
  async orchestrate(
    request: ChatOrchestrationRequest,
    userText: string,
    coreMessages: unknown[],
    avoidTools: string[],
    history: Array<{
      intentType: string;
      rawText: string;
      parameters: Record<string, unknown>;
    }>,
    lastInteractionContext?: {
      intentType?: string;
      rawText?: string;
      parameters?: Record<string, unknown>;
      timestamp?: string;
    } | null,
  ): Promise<ChatOrchestrationResult> {
    // 1. Security check
    const securityCheck = await this.checkSecurity(userText);
    if (!securityCheck.allowed) {
      // Return structured rejection instead of throwing a raw error
      const rejectionIntent: Intent = {
        id: randomUUID(),
        type: "UNKNOWN",
        confidence: 0,
        parameters: {},
        rawText: userText,
        explanation: `Input blocked for security reasons: ${securityCheck.detectionResult.explanation}`,
        requires_clarification: false,
        metadata: {
          version: "1.0.0",
          timestamp: new Date().toISOString(),
          source: "security_rejection",
          model_id: "unknown",
        },
      };

      return {
        intent: rejectionIntent,
        auditLogId: "rejected",
        requiresAsyncExecution: false,
      };
    }

    // 2. Infer intent
    const inferenceResult = await this.inferIntent(
      userText,
      avoidTools,
      history,
      lastInteractionContext,
    );
    const { intent } = inferenceResult;

    // 3. Create audit log (imported dynamically to avoid circular deps)
    const { createAuditLog } = await import("@/lib/audit");
    const auditLog = await createAuditLog(
      intent,
      undefined,
      request.userLocation || undefined,
      this.userContext.userIp,
    );

    // 4. Check if async execution is required
    if (this.requiresSagaExecution(intent.type)) {
      const executionId = await this.triggerAsyncExecution(intent, auditLog.id);
      return {
        intent,
        auditLogId: auditLog.id,
        executionId,
        requiresAsyncExecution: true,
      };
    }

    // 5. Fetch live operational state for non-saga requests
    const liveOperationalState = await this.fetchLiveState(
      coreMessages,
      request.userLocation || undefined,
      {
        intentType: intent.type,
        partySize: intent.parameters?.partySize as number | undefined,
        requestedTime: intent.parameters?.time as string | undefined,
        restaurantId: intent.parameters?.restaurantId as string | undefined,
      },
    );

    return {
      intent,
      auditLogId: auditLog.id,
      requiresAsyncExecution: false,
      liveOperationalState,
    };
  }
}

/**
 * Factory function to create a ChatOrchestratorService instance
 */
export function createChatOrchestrator(
  internalSystemKey: string,
  userContext: UserContext,
): ChatOrchestratorService {
  return new ChatOrchestratorService(internalSystemKey, userContext);
}
