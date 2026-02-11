import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { ToolDefinition } from "../../lib/engine/types";
import { z } from "zod";

/**
 * MCPClient connects to remote MCP servers and maps their tools 
 * to the engine's internal ToolDefinition format.
 */
export class MCPClient {
  private client: Client;
  private transport: SSEClientTransport;

  constructor(serverUrl: string) {
    this.transport = new SSEClientTransport(new URL(serverUrl));
    this.client = new Client(
      {
        name: "IntentionEngine-Orchestrator",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );
  }

  /**
   * Initialize the connection to the MCP server.
   */
  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  /**
   * Disconnect from the MCP server.
   */
  async disconnect(): Promise<void> {
    await this.client.close();
  }

  /**
   * Lists tools from the remote MCP server and converts them to Engine ToolDefinitions.
   */
  async listTools(): Promise<ToolDefinition[]> {
    const response = await this.client.listTools();
    return response.tools.map((tool) => this.mapMcpToolToEngineTool(tool));
  }

  /**
   * Calls a tool on the remote MCP server.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    return await this.client.callTool({
      name,
      arguments: args,
    });
  }

  /**
   * Maps an MCP tool definition to the engine's ToolDefinition.
   */
  private mapMcpToolToEngineTool(tool: McpTool): ToolDefinition {
    return {
      name: tool.name,
      version: "1.0.0", // MCP tools don't always have versions in the schema
      description: tool.description || "",
      inputSchema: {
        type: "object",
        properties: (tool.inputSchema as any).properties || {},
        required: (tool.inputSchema as any).required || [],
      },
      return_schema: {}, // MCP doesn't strictly define return schemas in tool list
      timeout_ms: 30000,
      requires_confirmation: false,
      category: "external",
    };
  }
}
