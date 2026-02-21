import { z } from "zod";

/**
 * IntentType defines the broad categories of user goals.
 * Keeping this under 5 types to maintain clarity and focus as per Phase 1.
 */
export const IntentTypeSchema = z.enum([
  "SCHEDULE",
  "SEARCH",
  "ACTION",
  "QUERY",
  "PLANNING",
  "ANALYSIS",
  "UNKNOWN",
  "CLARIFICATION_REQUIRED",
  "SERVICE_DEGRADED",
]);

export type IntentType = z.infer<typeof IntentTypeSchema>;

/**
 * Metadata for traceability and audit.
 */
export const IntentMetadataSchema = z.object({
  version: z.string(),
  timestamp: z.string(), // ISO-8601
  source: z.string().default("user_input"),
  model_id: z.string().optional(),
});

/**
 * The canonical Intent schema.
 */
export const IntentSchema = z.object({
  id: z.string().uuid(),
  parent_intent_id: z.string().uuid().optional(), // Link to the intent this one supersedes
  type: IntentTypeSchema,
  confidence: z.number().min(0).max(1),
  parameters: z.record(z.string(), z.any()),
  rawText: z.string(),
  explanation: z.string().optional(), // Why this intent was chosen
  hash: z.string().optional(), // SHA-256 hash for immutable linking
  metadata: IntentMetadataSchema,
  requires_clarification: z.boolean().default(false),
  clarification_prompt: z.string().optional(),
});

export type Intent = z.infer<typeof IntentSchema>;

export const RestaurantResultSchema = z.object({
  name: z.string(),
  address: z.string(),
  cuisine: z.array(z.string()).optional(),
  coordinates: z.object({
    lat: z.number(),
    lon: z.number(),
  }),
});

export type RestaurantResult = z.infer<typeof RestaurantResultSchema>;

export const StepSchema = z.object({
  id: z.string().uuid(),
  step_number: z.number().int().nonnegative(),
  tool_name: z.string(),
  tool_version: z.string().optional(),
  parameters: z.record(z.string(), z.any()),
  dependencies: z.array(z.string().uuid()).default([]),
  description: z.string(),
  requires_confirmation: z.boolean().default(false),
  timeout_ms: z.number().int().positive().default(30000),
  estimated_tokens: z.number().int().nonnegative().optional(),
  retry_policy: z.object({
    max_attempts: z.number().int().positive().default(1),
    backoff_ms: z.number().int().nonnegative().default(1000),
  }).optional(),
});

export const PlanConstraintsSchema = z.object({
  max_steps: z.number().int().positive().default(10),
  max_total_tokens: z.number().int().positive().default(100000),
  max_execution_time_ms: z.number().int().positive().default(300000),
  allowed_tools: z.array(z.string()).optional(),
  require_confirmation_for: z.array(z.string()).optional(),
});

export const PlanMetadataSchema = z.object({
  version: z.string().default("1.0.0"),
  created_at: z.string().datetime(),
  planning_model_id: z.string(),
  estimated_total_tokens: z.number().int().nonnegative(),
  estimated_latency_ms: z.number().int().nonnegative(),
});

export const PlanSchema = z.object({
  id: z.string().uuid(),
  intent_id: z.string().uuid(),
  steps: z.array(StepSchema).max(100),
  constraints: PlanConstraintsSchema,
  metadata: PlanMetadataSchema,
  summary: z.string(),
});

export type Step = z.infer<typeof StepSchema>;
export type Plan = z.infer<typeof PlanSchema>;

export const IntentResponseSchema = z.object({
  plan: PlanSchema,
  audit_log_id: z.string(),
});
