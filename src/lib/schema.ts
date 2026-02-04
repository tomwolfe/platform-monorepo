import { z } from "zod";

export const StepSchema = z.object({
  tool_name: z.string(),
  parameters: z.record(z.string(), z.any()),
  requires_confirmation: z.boolean(),
  description: z.string(), // Human readable description of the step
});

export const PlanSchema = z.object({
  intent_type: z.string(),
  constraints: z.array(z.string()),
  ordered_steps: z.array(StepSchema),
  summary: z.string(),
});

export type Step = z.infer<typeof StepSchema>;
export type Plan = z.infer<typeof PlanSchema>;

export const IntentResponseSchema = z.object({
  plan: PlanSchema,
  audit_log_id: z.string(),
});
