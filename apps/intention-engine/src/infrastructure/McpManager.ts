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
import { mapJsonSchemaToZod } from "../lib/engine/schema-utils";
import type { JSONSchema7, JSONSchema7Definition } from "json-schema";

/**
 * Recursive ToolParameter type that supports nested properties and items.
 * Extends the base ToolParameter with recursive structure support.
 */
interface RecursiveToolParameter extends ToolParameter {
  properties?: Record<string, RecursiveToolParameter>;
  items?: RecursiveToolParameter;
}

/**
 * McpAdapter provides bi-directional compatibility between
 * IntentionEngine tools and Model Context Protocol (MCP) tools.
 */
export class McpAdapter {
  /**
   * Converts a legacy ToolParameter array to an MCP-compliant JSON Schema inputSchema.
   * Supports nested objects and recursion for complex schemas.
   */
  static parametersToInputSchema(parameters: RecursiveToolParameter[]): JSONSchema7 {
    const properties: Record<string, JSONSchema7Definition> = {};
    const required: string[] = [];

    const mapType = (type: string): JSONSchema7["type"] => {
      switch (type) {
        case "string": return "string";
        case "number": return "number";
        case "boolean": return "boolean";
        case "object": return "object";
        case "array": return "array";
        default: return "string" as const;
      }
    };

    const processParam = (param: RecursiveToolParameter): JSONSchema7Definition => {
      const schema: JSONSchema7 = {
        type: mapType(param.type),
        description: param.description,
      };

      if (param.type === "object" && param.properties) {
        const objProperties: Record<string, JSONSchema7Definition> = {};
        const objRequired: string[] = [];

        for (const [propName, propValue] of Object.entries(param.properties)) {
          objProperties[propName] = processParam(propValue);
          if (propValue.required) {
            objRequired.push(propName);
          }
        }

        schema.properties = objProperties;
        if (objRequired.length > 0) {
          schema.required = objRequired;
        }
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
   * Wraps a legacy IntentionEngine tool to be exposed as an MCP tool.
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
 * McpManager handles MCP protocol handshake and tool execution.
 * Enhanced with strict type safety using Zod schemas
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
   * Enhanced with strict type validation using Zod schemas
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    try {
      // TYPE SAFETY: Validate parameters using Zod schema
      // First, try to validate against known tool schemas from AllToolsMap
      let validatedArgs: Record<string, unknown> = args;

      // Check if tool name matches a known tool in AllToolsMap
      if (this.isKnownTool(name)) {
        validatedArgs = validateToolParams(name as keyof AllToolsMap, args) as Record<string, unknown>;
      } else {
        // For dynamic/unknown tools, use JSON Schema to Zod conversion
        const schema = tool.inputSchema || McpAdapter.parametersToInputSchema(tool.parameters || []);
        const zodSchema = mapJsonSchemaToZod(schema);
        validatedArgs = zodSchema.parse(args) as Record<string, unknown>;
      }

      const result = await tool.execute(validatedArgs);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.result ?? result.error ?? {}),
          },
        ],
        isError: !result.success,
      };
    } catch (error: unknown) {
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

  /**
   * Type guard to check if a tool name is in AllToolsMap
   */
  private isKnownTool(name: string): name is keyof AllToolsMap {
    // Check against known tool names from the protocol
    const knownTools = [
      // TableStack
      'getAvailability', 'bookTable', 'getLiveOperationalState',
      // Table Management
      'get_table_availability', 'get_table_layout', 'get_reservation',
      'list_reservations', 'check_table_conflicts', 'create_reservation',
      'update_reservation', 'cancel_reservation', 'add_to_waitlist',
      'update_waitlist_status', 'validate_reservation',
      // OpenDelivery
      'calculateQuote', 'getDriverLocation',
      // Delivery Fulfillment
      'calculate_delivery_quote', 'fulfill_intent', 'get_fulfillment_status',
      'cancel_fulfillment', 'update_fulfillment', 'validate_fulfillment',
      // Mobility
      'request_ride', 'get_route_estimate',
      // Booking
      'reserve_restaurant',
      // Communication
      'send_comm',
      // Context
      'get_weather_data',
      // Parallel Execution
      'resolve_dependencies', 'execute_parallel',
    ];
    return knownTools.includes(name);
  }
}
