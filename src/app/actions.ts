"use server";

import { TOOLS, ToolDefinition, ExecuteToolResult } from "@/lib/tools";
import { getAuditLog, updateAuditLog, getUserAuditLogs } from "@/lib/audit";
import { replan } from "@/lib/llm";
import { AuditLog } from "@/lib/types";

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

  while (attempts < maxRetries) {
    try {
      result = await toolDef.execute(parameters);
      
      // Technical vs Logical error detection
      const technicalErrorKeywords = ["429", "network", "timeout", "fetch", "socket", "hang up", "overpass api error"];
      const isTechnicalError = !result.success && result.error && technicalErrorKeywords.some(k => result.error.toLowerCase().includes(k));

      if (isTechnicalError && attempts < maxRetries - 1) {
        throw new Error(result.error); // Trigger retry
      }
      
      break; 
    } catch (error: any) {
      attempts++;
      const errorMessage = error.message?.toLowerCase() || "";
      const isRetryable = errorMessage.includes('429') || 
                          errorMessage.includes('network') || 
                          errorMessage.includes('timeout') || 
                          errorMessage.includes('fetch') ||
                          errorMessage.includes('overpass api error');
      
      if (isRetryable && attempts < maxRetries) {
        const delay = Math.pow(2, attempts) * 1000;
        console.warn(`Technical error in ${tool_name}, retrying in ${delay}ms... (Attempt ${attempts}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      result = { success: false, error: error.message || "Unknown error" };
      break;
    }
  }

  // Schema Enforcement (Phase 1.2)
  if (result.success && toolDef.responseSchema) {
    const validation = toolDef.responseSchema.safeParse(result.result);
    if (!validation.success) {
      console.error(`Malformed tool output from ${tool_name}:`, validation.error.format());
      result = { 
        success: false, 
        error: `Validation Error: Tool output did not match expected schema. ${JSON.stringify(validation.error.format())}` 
      };
    } else {
        result.result = validation.data;
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
            error_explanation: errorExplanation
          };
        } catch (replanError: any) {
          console.error("Re-planning failed after tool failure:", replanError);
        }
      }
    }
  }

  return result;
}

export async function getPlanWithAvoidance(intent: string, userId: string = "anonymous") {
    // Phase 2: Memory & Guardrails - Fetch last 5 logs and extract failed tools
    const recentLogs = await getUserAuditLogs(userId, 5);
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
