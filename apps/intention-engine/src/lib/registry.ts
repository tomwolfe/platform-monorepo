import { TOOLS, ToolDefinition } from "./tools";
import { z } from "zod";
import { McpAdapter } from "../infrastructure/McpManager";
import { Logger } from "@repo/shared";

const logger = new Logger({ serviceName: 'intention-engine-registry' });

/**
 * Registers a new tool into the engine's registry at runtime.
 * This allows the engine to expand its capabilities dynamically.
 * 
 * @param definition - The JSON definition of the tool, including its schema and execution logic.
 */
export function registerDynamicTool(definition: {
  name: string;
  description: string;
  parameters: any; // Legacy parameters array or JSON Schema
  execute?: (params: any) => Promise<{ success: boolean; result?: any; error?: string }>;
  endpoint?: string;
}) {
  const { name, description, parameters, execute, endpoint } = definition;

  // Convert legacy parameters array to MCP-compliant inputSchema if necessary
  const inputSchema = Array.isArray(parameters) 
    ? McpAdapter.parametersToInputSchema(parameters)
    : parameters;
  
  const dynamicTool: ToolDefinition = {
    name,
    version: "1.0.0",
    description,
    inputSchema,
    return_schema: { result: "any" },
    timeout_ms: 30000,
    requires_confirmation: false,
    category: "external",
    execute: execute || (async (params: any) => {
      if (!endpoint) {
        return { success: false, error: `No execution logic or endpoint provided for tool: ${name}` };
      }

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return { success: false, error: `External tool API error: ${errorText || response.statusText}` };
        }

        const result = await response.json();
        return { success: true, result };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { success: false, error: `Failed to execute dynamic tool ${name}: ${errorMessage}` };
      }
    })
  };

  TOOLS.set(name, dynamicTool);
  logger.info(`Successfully registered dynamic tool: ${name}`);
}
