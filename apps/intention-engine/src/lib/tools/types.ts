import { z } from "zod";
import {
  ToolDefinition as EngineToolDefinition,
  ToolParameter,
} from "../engine/types";
import type { ToolExecutionContext } from "../engine/tools/registry";

/**
 * Tool definition metadata without execute function.
 * Used for exporting tool definitions before registration.
 */
export interface ToolDefinitionMetadata extends EngineToolDefinition {
  /** Optional Zod schema for response validation */
  responseSchema?: z.ZodType<unknown>;
}

/**
 * Extended ToolDefinition that includes the execute function
 * and optional Zod responseSchema for runtime validation.
 */
export interface ToolDefinition extends ToolDefinitionMetadata {
  /** Execution function for the tool */
  execute: (
    params: Record<string, unknown>,
    context?: ToolExecutionContext,
  ) => Promise<{ success: boolean; result?: unknown; error?: string }>;
}

export type ExecuteToolResult = {
  success: boolean;
  result?: unknown;
  error?: string;
  replanned?: boolean;
  new_plan?: unknown;
  error_explanation?: string;
};

export type { ToolParameter };
