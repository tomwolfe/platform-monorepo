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

/**
 * McpAdapter provides bi-directional compatibility between 
 * IntentionEngine tools and Model Context Protocol (MCP) tools.
 */
export class McpAdapter {
  /**
   * Converts a legacy ToolParameter array to an MCP-compliant JSON Schema inputSchema.
   * Supports nested objects and recursion for complex schemas.
   */
  static parametersToInputSchema(parameters: ToolParameter[]): any {
    const properties: Record<string, any> = {};
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

    const processParam = (param: any): any => {
      const schema: any = {
        type: mapType(param.type),
        description: param.description,
      };

      if (param.type === "object" && param.properties) {
        schema.properties = {};
        schema.required = [];
        for (const [propName, propValue] of Object.entries(param.properties)) {
          schema.properties[propName] = processParam(propValue);
          if ((propValue as any).required) {
            schema.required.push(propName);
          }
        }
        if (schema.required.length === 0) delete schema.required;
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
      inputSchema: tool.inputSchema || this.parametersToInputSchema((tool as any).parameters || []),
    };
  }
}

/**
 * McpManager handles MCP protocol handshake and transport.
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
   */
  async callTool(name: string, args: any): Promise<CallToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    try {
      const result = await tool.execute(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.result || result.error || {}),
          },
        ],
        isError: !result.success,
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: error.message || "Unknown error during tool execution",
          },
        ],
        isError: true,
      };
    }
  }
}
