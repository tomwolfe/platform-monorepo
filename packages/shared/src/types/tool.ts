/**
 * Tool Definition Types
 *
 * Shared tool definition schema used across all apps.
 *
 * @see Phase 2.2: Kill Duplicate Registries
 */

import { z } from "zod";

// ============================================================================
// TOOL PARAMETER SCHEMA
// ============================================================================

export const ToolParameterSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  description: z.string(),
  required: z.boolean().default(false),
  default_value: z.unknown().optional(),
  validation_regex: z.string().optional(),
  enum_values: z.array(z.string()).optional(),
});

export type ToolParameter = z.infer<typeof ToolParameterSchema>;

// ============================================================================
// TOOL DEFINITION SCHEMA
// Note: execute function is NOT part of the schema (can't be serialized)
// Add it separately to the TypeScript type only
// ============================================================================

export const ToolDefinitionSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  inputSchema: z.object({
    type: z.literal("object"),
    properties: z.record(z.string(), z.any()),
    required: z.array(z.string()).optional(),
    anyOf: z.array(z.any()).optional(),
    oneOf: z.array(z.any()).optional(),
    allOf: z.array(z.any()).optional(),
  }),
  return_schema: z.record(z.string(), z.unknown()),
  parameter_aliases: z.record(z.string(), z.string()).optional(),
  timeout_ms: z.number().int().positive().default(30000),
  requires_confirmation: z.boolean().default(false),
  category: z.enum([
    "data",
    "action",
    "communication",
    "calculation",
    "external",
    "search",
  ]),
  origin: z.string().optional(),
  rate_limits: z
    .object({
      requests_per_minute: z.number().int().positive().optional(),
      requests_per_hour: z.number().int().positive().optional(),
    })
    .optional(),
  responseSchema: z.any().optional(),
});

// Extended type with optional execute function (not serialized)
export interface ToolDefinition extends z.infer<typeof ToolDefinitionSchema> {
  execute?: (...args: unknown[]) => Promise<unknown>;
}
