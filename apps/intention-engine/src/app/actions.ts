"use server";

import { TOOLS, ToolDefinition, ExecuteToolResult } from "@/lib/tools";
import { getAuditLog, updateAuditLog, getUserAuditLogs } from "@/lib/audit";
import { replan } from "@/lib/planner";
import { AuditLog } from "@/lib/types";

import { startTrace } from "@/lib/observability";
import { withNervousSystemTracing } from "@repo/shared/tracing";

/**
 * Generate conversational repair suggestions based on tool failure
 * This provides the LLM with structured alternatives to offer the user
 */
function generateRepairSuggestions(
  toolName: string,
  errorMessage: string,
  errorType: "validation" | "logic"
): Array<{
  type: string;
  message: string;
  action?: string;
}> {
  const suggestions: Array<{ type: string; message: string; action?: string }> = [];

  // Validation errors - suggest parameter fixes
  if (errorType === "validation") {
    if (errorMessage.includes("required") || errorMessage.includes("missing")) {
      suggestions.push({
        type: "MISSING_PARAMETER",
        message: "I need a bit more information to complete this. Let me ask for what's missing.",
        action: "ask_for_missing_param",
      });
    }
    if (errorMessage.includes("invalid") || errorMessage.includes("format")) {
      suggestions.push({
        type: "INVALID_FORMAT",
        message: "Let me correct the format and try again.",
        action: "reformat_and_retry",
      });
    }
  }

  // Logic errors - suggest alternatives based on tool type
  if (errorType === "logic") {
    // Booking/Reservation failures
    if (toolName.includes("book") || toolName.includes("reserve")) {
      if (errorMessage.includes("full") || errorMessage.includes("unavailable")) {
        suggestions.push(
          {
            type: "ALTERNATIVE_TIME",
            message: "That time is fully booked. Would you like to try a different time?",
            action: "suggest_alternative_time",
          },
          {
            type: "WAITLIST",
            message: "I can add you to the waitlist instead - current wait is about 15-30 minutes.",
            action: "suggest_waitlist",
          },
          {
            type: "DELIVERY_ALTERNATIVE",
            message: "Delivery is available from this restaurant if you'd prefer that.",
            action: "suggest_delivery",
          }
        );
      }
      if (errorMessage.includes("party size") || errorMessage.includes("too large")) {
        suggestions.push({
          type: "SPLIT_RESERVATION",
          message: "That party size requires special handling. Let me connect you with the restaurant directly.",
          action: "escalate_to_human",
        });
      }
    }

    // Delivery failures
    if (toolName.includes("delivery") || toolName.includes("dispatch")) {
      if (errorMessage.includes("no drivers") || errorMessage.includes("unavailable")) {
        suggestions.push({
          type: "HIGH_DEMAND",
          message: "Drivers are in high demand right now. Increasing your tip by $3-5 may attract a driver faster.",
          action: "suggest_tip_boost",
        });
      }
      if (errorMessage.includes("address") || errorMessage.includes("location")) {
        suggestions.push({
          type: "INVALID_ADDRESS",
          message: "Let me verify the delivery address. Could you confirm or provide an alternative?",
          action: "verify_address",
        });
      }
    }

    // Payment failures
    if (toolName.includes("payment") || toolName.includes("checkout")) {
      suggestions.push({
        type: "PAYMENT_RETRY",
        message: "The payment didn't go through. Would you like to try again or use a different payment method?",
        action: "retry_payment",
      });
    }

    // Generic technical errors
    if (errorMessage.includes("timeout") || errorMessage.includes("network") || errorMessage.includes("connection")) {
      suggestions.push({
        type: "TECHNICAL_RETRY",
        message: "I'm experiencing a technical issue. Let me try that again for you.",
        action: "automatic_retry",
      });
    }
  }

  // Fallback suggestion
  if (suggestions.length === 0) {
    suggestions.push({
      type: "GENERAL_ALTERNATIVE",
      message: "Let me find an alternative solution for you.",
      action: "find_alternative",
    });
  }

  return suggestions;
}

export async function executeToolWithContext(
  tool_name: string, 
  parameters: any, 
  context: { audit_log_id: string; step_index: number }
): Promise<ExecuteToolResult> {
  const toolDef = TOOLS.get(tool_name);
  if (!toolDef) {
    throw new Error(`Tool ${tool_name} not found`);
  }

  const startTime = Date.now();
  let result: any;
  let attempts = 0;
  const maxRetries = 3;

  const traceId = context.audit_log_id;
  const span = startTrace(`tool_execution:${tool_name}`, traceId);

  result = await withNervousSystemTracing(async () => {
    while (attempts < maxRetries) {
      try {
        result = await toolDef.execute(parameters);
        
        // Technical vs Logical error detection
        const technicalErrorKeywords = [
          "429", "network", "timeout", "fetch", "socket", "hang up", 
          "overpass api error", "rate limit", "503", "502", "504", 
          "internal server error", "connection refused"
        ];
        const isTechnicalError = !result.success && result.error && technicalErrorKeywords.some(k => result.error.toLowerCase().includes(k));

        if (isTechnicalError && attempts < maxRetries - 1) {
          throw new Error(result.error); // Trigger retry
        }
        
        return result; 
      } catch (error: any) {
        attempts++;
        const errorMessage = error.message?.toLowerCase() || "";
        const isRetryable = errorMessage.includes('429') || 
                            errorMessage.includes('network') || 
                            errorMessage.includes('timeout') || 
                            errorMessage.includes('fetch') ||
                            errorMessage.includes('overpass api error') ||
                            errorMessage.includes('rate limit') ||
                            errorMessage.includes('503') ||
                            errorMessage.includes('502') ||
                            errorMessage.includes('504');
        
        if (isRetryable && attempts < maxRetries) {
          const delay = Math.pow(2, attempts) * 1000;
          console.warn(`Technical error in ${tool_name}, retrying in ${delay}ms... (Attempt ${attempts}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        return { success: false, error: error.message || "Unknown error" };
      }
    }
  }, { 'x-correlation-id': traceId });

  span.end();


  // Schema Enforcement (Phase 1.2)
  if (result.success && toolDef.responseSchema) {
    try {
      // Use parse to throw ZodError and catch it for logical-error wrapping
      result.result = toolDef.responseSchema.parse(result.result);
    } catch (validationError: any) {
      if (validationError.name === "ZodError") {
        console.error(`Malformed tool output from ${tool_name}:`, validationError.format());
        result = { 
          success: false, 
          error: `Logical Error (Validation): Tool output did not match expected schema. ${JSON.stringify(validationError.format())}` 
        };
      } else {
        throw validationError;
      }
    }
  }

  const duration = Date.now() - startTime;

  const log = await getAuditLog(context.audit_log_id);
  if (log) {
    const toolExecutionLatencies = log.toolExecutionLatencies || { latencies: {}, totalToolExecutionTime: 0 };
    const latencies = toolExecutionLatencies.latencies[tool_name] || [];
    latencies.push(duration);
    toolExecutionLatencies.latencies[tool_name] = latencies;
    toolExecutionLatencies.totalToolExecutionTime = (toolExecutionLatencies.totalToolExecutionTime || 0) + duration;

    // Latency Monitoring (Phase 1.3)
    const total_latency = toolExecutionLatencies.totalToolExecutionTime;
    const efficiency_flag = total_latency > 5000 ? "LOW" : undefined;

    const newStep = {
      step_index: context.step_index,
      tool_name,
      status: (result.success ? "executed" : "failed") as any,
      input: parameters,
      output: result.result,
      error: result.error,
      timestamp: new Date().toISOString(),
      latency: duration
    };

    const updatedSteps = [...log.steps.filter(s => s.step_index !== context.step_index), newStep];

    await updateAuditLog(context.audit_log_id, { 
      toolExecutionLatencies,
      steps: updatedSteps,
      efficiency_flag: efficiency_flag as any
    });

    if (result.success === false) {
      console.log(`Tool ${tool_name} returned success: false, triggering re-plan...`);

      // Determine error type (Phase 1.1)
      const validationKeywords = ['invalid', 'missing', 'type', 'validation'];
      const errorType = result.error && validationKeywords.some(k => result.error.toLowerCase().includes(k))
        ? "validation"
        : "logic";

      // Generate conversational repair suggestions based on error type
      const repairSuggestions = generateRepairSuggestions(tool_name, result.error, errorType);

      if (log.plan) {
        try {
          const errorExplanation = `Step ${context.step_index} (${tool_name}) failed: ${result.error || "Unknown error"}`;
          console.log(`Re-planning with explanation: ${errorExplanation} (Type: ${errorType})`);

          const newPlan = await replan(
            log.intent,
            { ...log, steps: updatedSteps },
            context.step_index,
            result.error || "Tool returned failure",
            { parameters, result },
            errorType as any
          );

          await updateAuditLog(context.audit_log_id, {
            plan: newPlan,
            replanned_count: (log.replanned_count || 0) + 1,
            final_outcome: `Re-planned due to failure in ${tool_name}. ${errorExplanation}`
          });

          return {
            ...result,
            replanned: true,
            new_plan: newPlan,
            error_explanation: errorExplanation,
            repair_suggestions: repairSuggestions
          };
        } catch (replanError: any) {
          console.error("Re-planning failed after tool failure:", replanError);
          // Return repair suggestions even if replanning failed
          return {
            ...result,
            repair_suggestions: repairSuggestions
          };
        }
      }
    }
  }

  return result;
}

export async function getPlanWithAvoidance(intent: string, userId: string) {
    if (!userId || userId === "anonymous") {
        console.warn(`[Guardrails] getPlanWithAvoidance called with ${userId ? 'anonymous' : 'missing'} user context for intent: "${intent.slice(0, 50)}..."`);
    }
    // Phase 2: Memory & Guardrails - Fetch last 5 logs and extract failed tools
    const recentLogs = await getUserAuditLogs(userId || "anonymous", 5);
    const avoidTools: string[] = [];
    
    for (const log of recentLogs) {
        if (log.steps) {
            for (const step of log.steps) {
                if (step.status === "failed") {
                    avoidTools.push(step.tool_name);
                }
            }
        }
    }
    
    // We'll pass this to intent inference/planning logic
    return {
        avoidTools: Array.from(new Set(avoidTools))
    };
}

export async function getProvider(intentType: string) {
    // Phase 3: Multi-Provider Support
    // Use GLM-4 for 'search' and 'booking' intents, but route 'analysis' intents to OpenAI.
    if (intentType === "ANALYSIS") {
        return {
            provider: "openai",
            apiKey: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY,
            model: "gpt-4o", // Default to gpt-4o for analysis
            baseUrl: "https://api.openai.com/v1"
        };
    }
    
    return {
        provider: "glm",
        apiKey: process.env.LLM_API_KEY,
        model: process.env.LLM_MODEL || "glm-4.7-flash",
        baseUrl: process.env.LLM_BASE_URL || "https://api.z.ai/api/paas/v4"
    };
}
