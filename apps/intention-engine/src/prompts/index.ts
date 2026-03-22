/**
 * Prompt Versioning System
 * 
 * Purpose: Track and manage prompt versions for reproducibility and rollback.
 * 
 * Usage:
 * ```typescript
 * import { prompts, getCurrentVersion } from '@/lib/engine/prompts';
 * 
 * const prompt = prompts.planning.v2;
 * const version = getCurrentVersion('planning'); // 'v2.1.0'
 * ```
 */

// ============================================================================
// PROMPT VERSIONS
// ============================================================================

/**
 * Planning Prompt v1.0.0
 * Initial prompt for plan generation
 */
export const PLANNING_PROMPT_V1 = `You are an expert planner. Given a user intent, generate a sequence of tool calls to accomplish the goal.

Rules:
1. Each step must use an available tool
2. Respect tool dependencies
3. Minimize the number of steps
4. Include all required parameters

Intent: {{intent}}
Available Tools: {{tools}}

Generate a plan:`;

/**
 * Planning Prompt v2.0.0
 * Added: Context injection from recent successful intents
 * Added: Parameter aliasing guidance
 * Added: Constraint enforcement
 */
export const PLANNING_PROMPT_V2 = `You are an expert planner for a multi-agent system. Generate validated execution plans from user intents.

## Rules:
1. Each step must use an available tool from the provided list
2. Respect tool
3. Minimize steps while ensuring completeness
4. Include ALL required parameters for each tool
5. Apply parameter aliases (e.g., "time" → "reservation_time" if needed)

## Constraints:
- Maximum {{max_steps}} steps
- Maximum {{max_tokens}} total tokens
- No forbidden sequences (e.g., search → delete_account)

## Recent Successful Examples:
{{context_history}}

## Input:
Intent Type: {{intent_type}}
Parameters: {{parameters}}
Raw Input: {{raw_text}}

Generate a plan in JSON format:`;

/**
 * Planning Prompt v2.1.0
 * Added: Live state gate for booking intents
 * Added: Merge rule for dining + delivery
 */
export const PLANNING_PROMPT_V2_1 = `You are an expert planner for a multi-agent system. Generate validated execution plans from user intents.

## Rules:
1. Each step must use an available tool from the provided list
2. Respect tool dependencies (DAG structure)
3. Minimize steps while ensuring completeness
4. Include ALL required parameters for each tool
5. Apply parameter aliases (e.g., "time" → "reservation_time" if needed)

## Constraints:
- Maximum {{max_steps}} steps
- Maximum {{max_tokens}} total tokens
- No forbidden sequences (e.g., search → delete_account)

## Special Rules:
- MERGE RULE: If user requests both dining and delivery for same restaurant/time, create a UNIFIED plan with coordinated timing
- LIVE STATE: If restaurant table is unavailable, suggest delivery alternative

## Recent Successful Examples:
{{context_history}}

## Input:
Intent Type: {{intent_type}}
Parameters: {{parameters}}
Raw Input: {{raw_text}}
{{live_state_constraint}}

Generate a plan in JSON format:`;

/**
 * Intent Parsing Prompt v1.0.0
 * Initial intent classification prompt
 */
export const INTENT_PARSING_PROMPT_V1 = `Classify the user's intent into one of these categories:
- ACTION: Execute a tool or command
- SEARCH: Query for information
- SCHEDULE: Time-based reminder or action
- BOOKING: Reservation-specific action

Input: {{user_input}}
Location: {{location}}

Classify and extract parameters:`;

/**
 * Intent Parsing Prompt v2.0.0
 * Added: Fan-out support for array parameters
 * Added: Confidence scoring
 */
export const INTENT_PARSING_PROMPT_V2 = `You are an intent classification system. Analyze user input and extract structured intents.

## Intent Types:
- ACTION: Execute a tool or command (e.g., "book a table")
- SEARCH: Query for information (e.g., "find restaurants")
- SCHEDULE: Time-based action (e.g., "remind me at 3pm")
- BOOKING: Reservation-specific (subclass of ACTION)

## Rules:
1. Extract ALL parameters, including arrays (fan-out)
2. Provide confidence score (0.0 - 1.0)
3. Handle ambiguous input with clarification requests

## Input:
User Message: {{user_input}}
Location: {{lat}}, {{lng}}
Context: {{context}}

Output JSON with intent type, parameters, and confidence:`;

// ============================================================================
// PROMPT REGISTRY
// ============================================================================

export const prompts = {
  planning: {
    "v1.0.0": PLANNING_PROMPT_V1,
    "v2.0.0": PLANNING_PROMPT_V2,
    "v2.1.0": PLANNING_PROMPT_V2_1,
  },
  intent_parsing: {
    "v1.0.0": INTENT_PARSING_PROMPT_V1,
    "v2.0.0": INTENT_PARSING_PROMPT_V2,
  },
} as const;

// ============================================================================
// VERSION MANAGEMENT
// ============================================================================

/**
 * Get current production version for a prompt type
 */
const CURRENT_VERSIONS = {
  planning: "v2.1.0",
  intent_parsing: "v2.0.0",
} as const;

export function getCurrentVersion(promptType: keyof typeof CURRENT_VERSIONS): string {
  return CURRENT_VERSIONS[promptType];
}

/**
 * Get prompt by type and version
 */
export function getPrompt(
  promptType: keyof typeof prompts,
  version?: string
): string {
  const v = version || getCurrentVersion(promptType);
  return prompts[promptType][v as keyof typeof prompts[typeof promptType]];
}

/**
 * Get all available versions for a prompt type
 */
export function getAvailableVersions(promptType: keyof typeof prompts): string[] {
  return Object.keys(prompts[promptType]);
}

/**
 * Prompt metadata for tracking
 */
export interface PromptMetadata {
  version: string;
  created_at: string;
  updated_at: string;
  author: string;
  changes: string[];
  rollback_safe: boolean;
}

export const PROMPT_METADATA: Record<string, PromptMetadata> = {
  "planning:v2.1.0": {
    version: "v2.1.0",
    created_at: "2026-03-22T00:00:00Z",
    updated_at: "2026-03-22T00:00:00Z",
    author: "system",
    changes: [
      "Added merge rule for dining + delivery coordination",
      "Added live state gate for booking intents",
    ],
    rollback_safe: true,
  },
  "planning:v2.0.0": {
    version: "v2.0.0",
    created_at: "2026-03-15T00:00:00Z",
    updated_at: "2026-03-15T00:00:00Z",
    author: "system",
    changes: [
      "Added context injection from recent intents",
      "Added parameter aliasing guidance",
      "Added explicit constraint enforcement",
    ],
    rollback_safe: true,
  },
  "planning:v1.0.0": {
    version: "v1.0.0",
    created_at: "2026-03-01T00:00:00Z",
    updated_at: "2026-03-01T00:00:00Z",
    author: "system",
    changes: ["Initial prompt version"],
    rollback_safe: true,
  },
  "intent_parsing:v2.0.0": {
    version: "v2.0.0",
    created_at: "2026-03-20T00:00:00Z",
    updated_at: "2026-03-20T00:00:00Z",
    author: "system",
    changes: [
      "Added fan-out support for array parameters",
      "Added confidence scoring",
    ],
    rollback_safe: true,
  },
  "intent_parsing:v1.0.0": {
    version: "v1.0.0",
    created_at: "2026-03-01T00:00:00Z",
    updated_at: "2026-03-01T00:00:00Z",
    author: "system",
    changes: ["Initial intent parsing prompt"],
    rollback_safe: true,
  },
};

/**
 * Get metadata for a specific prompt version
 */
export function getPromptMetadata(promptType: string, version: string): PromptMetadata | undefined {
  return PROMPT_METADATA[`${promptType}:${version}`];
}

/**
 * Log prompt version used in execution
 */
export function logPromptUsage(
  promptType: string,
  version: string,
  executionId: string
): void {
  console.log(`[PromptVersion] ${promptType}:${version} used in execution ${executionId}`);
  
  // In production, this would publish to an observability system
  // e.g., RealtimeService.publishNervousSystemEvent("prompt_used", {...})
}
