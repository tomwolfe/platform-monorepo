import {
  ToolDefinition as EngineToolDefinition,
  ToolParameter
} from "../lib/engine/types";
import { ToolDefinition as RegistryToolDefinition } from "../lib/tools/types";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CallToolResult
} from "@modelcontextprotocol/sdk/types.js";
import * as zod from "zod";
import { AllToolsMap, ToolInput, validateToolParams } from "@repo/mcp-protocol";

/**
 * McpAdapter provides bi-directional compatibility between
 * IntentionEngine tools and Model Context Protocol (MCP) tools.
 */
export class McpAdapter {
  /**
   * Converts a legacy ToolParameter array to an MCP-compliant JSON Schema inputSchema.
   * Supports nested objects and recursion for complex schemas.
   */
  static parametersToInputSchema(parameters: ToolParameter[]): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    const mapType = (type: string) => {
      switch (type) {
        case "string": return "string";
        case "number": return "number";
        case "boolean": return "boolean";
        case "object": return "object";
        case "array": return "array";
        default: return "string";
      }
    };

    const processParam = (param: ToolParameter): Record<string, unknown> => {
      const schema: Record<string, unknown> = {
        type: mapType(param.type),
        description: param.description,
      };

      if (param.type === "object" && param.properties) {
        schema.properties = {} as Record<string, unknown>;
        schema.required = [] as string[];
        for (const [propName, propValue] of Object.entries(param.properties)) {
          (schema.properties as Record<string, unknown>)[propName] = processParam(propValue as ToolParameter);
          if ((propValue as ToolParameter).required) {
            (schema.required as string[]).push(propName);
          }
        }
        if ((schema.required as string[]).length === 0) delete schema.required;
      }

      if (param.type === "array" && param.items) {
        schema.items = processParam(param.items);
      }

      if (param.enum_values) {
        schema.enum = param.enum_values;
      }

      if (param.default_value !== undefined) {
        schema.default = param.default_value;
      }

      return schema;
    };

    for (const param of parameters) {
      properties[param.name] = processParam(param);
      if (param.required) {
        required.push(param.name);
      }
    }

    return {
      type: "object",
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  /**
   * Wraps an IntentionEngine tool to be exposed as an MCP tool.
   */
  static toMcpTool(tool: RegistryToolDefinition) {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema || this.parametersToInputSchema(tool.parameters || []),
    };
  }
}

/**
 * McpManager handles MCP protocol handshake and transport.
 * Enhanced with strict type safety using AllToolsMap from @repo/mcp-protocol
 */
export class McpManager {
  private tools: Map<string, RegistryToolDefinition> = new Map();

  constructor(tools: RegistryToolDefinition[]) {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * Handles an MCP ListTools request.
   */
  async listTools() {
    return {
      tools: Array.from(this.tools.values()).map(tool => McpAdapter.toMcpTool(tool)),
    };
  }

  /**
   * Handles an MCP CallTool request.
   * Enhanced with strict type validation using AllToolsMap
   */
  async callTool<TToolName extends keyof AllToolsMap>(
    name: TToolName,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    const tool = this.tools.get(name as string);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    try {
      // Validate parameters using the Zod schema from AllToolsMap
      // This ensures type safety at runtime
      const validatedArgs = validateToolParams(name, args);

      const result = await tool.execute(validatedArgs);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.result || result.error || {}),
          },
        ],
        isError: !result.success,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error during tool execution";
      return {
        content: [
          {
            type: "text",
            text: errorMessage,
          },
        ],
        isError: true,
      };
    }
  }
}
