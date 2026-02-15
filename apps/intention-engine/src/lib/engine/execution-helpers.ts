/**
 * Execution Helpers for Orchestrator
 * Idempotency, Validation, and Error Recovery utilities
 */

import { PlanStep, StepExecutionState } from "./types";
import { NormalizationService } from "@repo/shared";
import { generateText } from "./llm";

/**
 * Validation result before execution
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Perform dry-run validation before executing a step
 * This prevents partial state updates on validation failures
 */
export async function validateBeforeExecution(
  step: PlanStep,
  parameters: Record<string, unknown>
): Promise<ValidationResult> {
  // Validate parameters against tool schema using NormalizationService
  const validationResult = NormalizationService.validateToolParameters(
    step.tool_name,
    parameters
  );

  if (!validationResult.success) {
    const errorMessages = validationResult.errors
      .map(e => `${e.path}: ${e.message}`)
      .join("; ");
    
    return {
      valid: false,
      error: `Parameter validation failed: ${errorMessages}`,
    };
  }

  // Additional semantic validation based on tool type
  if (step.tool_name.toLowerCase().includes("book") || 
      step.tool_name.toLowerCase().includes("reserve")) {
    // Ensure required booking fields are present
    const requiredFields = ["restaurantId", "partySize", "startTime"];
    const missingFields = requiredFields.filter(f => !parameters[f]);
    
    if (missingFields.length > 0) {
      return {
        valid: false,
        error: `Missing required booking fields: ${missingFields.join(", ")}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Extract HTTP error code from error string
 */
export function extractErrorCode(error?: string): number | undefined {
  if (!error) return undefined;
  
  // Match patterns like "400 Bad Request", "status 500", "HTTP 404"
  const patterns = [
    /(\d{3})\s+(Bad|Unauthorized|Forbidden|Not|Error|Server)/i,
    /status\s*(?:code)?\s*:?\s*(\d{3})/i,
    /HTTP\s*(\d{3})/i,
    /error\s*(\d{3})/i,
  ];
  
  for (const pattern of patterns) {
    const match = error.match(pattern);
    if (match) {
      const code = parseInt(match[1], 10);
      if (code >= 400 && code < 600) {
        return code;
      }
    }
  }
  
  return undefined;
}

/**
 * Check if error code is a 4xx or 5xx error
 */
export function isClientOrServerError(code?: number): boolean {
  return code !== undefined && (code >= 400 && code < 600);
}

/**
 * Error recovery result
 */
export interface ErrorRecoveryResult {
  recovered: boolean;
  correctedParameters?: Record<string, unknown>;
  refinedPlan?: string;
  reason?: string;
}

/**
 * Attempt to recover from execution errors using NormalizationService
 * and LLM-based parameter correction
 */
export async function attemptErrorRecovery(
  step: PlanStep,
  parameters: Record<string, unknown>,
  errorMessage: string,
  errorCode?: number
): Promise<ErrorRecoveryResult> {
  console.log(`[Error Recovery] Attempting recovery for step ${step.tool_name} (HTTP ${errorCode})`);
  
  // First, try normalization service to validate parameters
  const validationResult = NormalizationService.validateToolParameters(
    step.tool_name,
    parameters
  );
  
  if (!validationResult.success) {
    // Parameters are invalid - attempt LLM-based correction
    console.log(`[Error Recovery] Parameters invalid, attempting LLM correction`);
    
    const correctionPrompt = `Fix the following parameters for tool "${step.tool_name}" that failed with error: ${errorMessage}

Current Parameters: ${JSON.stringify(parameters, null, 2)}

Validation Errors: ${validationResult.errors.map(e => `${e.path}: ${e.message}`).join(", ")}

Please provide corrected parameters that will fix the validation errors.
Respond with ONLY a valid JSON object containing the corrected parameters.`;

    try {
      const correctionResponse = await generateText({
        modelType: "execution",
        prompt: correctionPrompt,
        systemPrompt: "You are a parameter correction assistant. Fix parameter validation errors by adjusting values to meet schema requirements. Output ONLY valid JSON.",
        temperature: 0.2,
      });

      const correctedParams = JSON.parse(correctionResponse.content.trim());
      
      // Validate the corrected parameters
      const revalidation = NormalizationService.validateToolParameters(
        step.tool_name,
        correctedParams
      );
      
      if (revalidation.success) {
        console.log(`[Error Recovery] Successfully corrected parameters`);
        return {
          recovered: true,
          correctedParameters: correctedParams,
          reason: "Parameters corrected via LLM",
        };
      } else {
        console.log(`[Error Recovery] LLM correction failed validation`);
      }
    } catch (llmError) {
      console.error(`[Error Recovery] LLM correction failed:`, llmError);
    }
  }
  
  // For 5xx errors, we might want to generate a refined plan
  if (errorCode && errorCode >= 500) {
    console.log(`[Error Recovery] Server error detected, generating refined plan`);
    
    const refinementPrompt = `The following operation failed with a server error (HTTP ${errorCode}):

Tool: ${step.tool_name}
Parameters: ${JSON.stringify(parameters, null, 2)}
Error: ${errorMessage}

This appears to be a transient server error. Suggest whether to:
1. Retry with same parameters
2. Retry with modified parameters  
3. Skip this step and continue
4. Fail the execution

Respond with ONLY a JSON object in this format:
{
  "action": "retry_same" | "retry_modified" | "skip" | "fail",
  "reason": "explanation",
  "modifiedParams": { ... } // only if action is "retry_modified"
}`;

    try {
      const refinementResponse = await generateText({
        modelType: "planning",
        prompt: refinementPrompt,
        systemPrompt: "You are an execution recovery assistant. Analyze server errors and suggest appropriate recovery actions.",
        temperature: 0.1,
      });

      const refinement = JSON.parse(refinementResponse.content.trim());
      
      if (refinement.action === "retry_modified" && refinement.modifiedParams) {
        return {
          recovered: true,
          correctedParameters: refinement.modifiedParams,
          reason: refinement.reason,
        };
      } else if (refinement.action === "skip") {
        return {
          recovered: true,
          reason: `Step skipped: ${refinement.reason}`,
        };
      }
    } catch (refinementError) {
      console.error(`[Error Recovery] Plan refinement failed:`, refinementError);
    }
  }
  
  return {
    recovered: false,
    reason: "Unable to recover from error automatically",
  };
}

/**
 * Log execution results from Promise.allSettled
 * Ensures no floating promises and proper error logging
 */
export function logExecutionResults(
  stepIds: string[],
  results: Array<PromiseSettledResult<StepExecutionState>>,
  phase: string
): void {
  const timestamp = new Date().toISOString();
  
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const stepId = stepIds[i];
    
    if (result.status === "fulfilled") {
      const stepResult = result.value;
      console.log(`[${phase}] Step ${stepId} completed:`, {
        timestamp,
        stepId,
        status: stepResult.status,
        latencyMs: stepResult.latency_ms,
        attempts: stepResult.attempts,
      });
    } else {
      console.error(`[${phase}] Step ${stepId} failed with exception:`, {
        timestamp,
        stepId,
        error: result.reason,
      });
    }
  }
}
