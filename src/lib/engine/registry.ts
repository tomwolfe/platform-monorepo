import { ToolRegistry, getToolRegistry } from "./tools/registry";
import { MCPClient } from "../../infrastructure/mcp/MCPClient";
import { ToolDefinition } from "./types";
import { Tracer } from "./tracing";

/**
 * RegistryManager coordinates local and remote tool discovery.
 */
export class RegistryManager {
  private localRegistry: ToolRegistry;
  private mcpClients: Map<string, MCPClient> = new Map();

  constructor() {
    this.localRegistry = getToolRegistry();
    
    // Initialize MCP clients from environment
    if (process.env.GITHUB_MCP_URL) {
      this.mcpClients.set("github", new MCPClient(process.env.GITHUB_MCP_URL));
    }
    if (process.env.BRAVE_SEARCH_MCP_URL) {
      this.mcpClients.set("brave-search", new MCPClient(process.env.BRAVE_SEARCH_MCP_URL));
    }
    if (process.env.VERCEL_MCP_URL) {
      this.mcpClients.set("vercel", new MCPClient(process.env.VERCEL_MCP_URL));
    }
  }

  /**
   * Discovers tools from all connected MCP servers and populates the local registry.
   */
  async discoverRemoteTools(): Promise<void> {
    return Tracer.startActiveSpan("discover_remote_tools", async (span) => {
      const clients = Array.from(this.mcpClients.entries());
      for (const [name, client] of clients) {
        try {
          await client.connect();
          const remoteTools = await client.listTools();
          
          for (const tool of remoteTools) {
            // Register a wrapper implementation that calls the MCP server
            // Note: Registry.register already validates the ToolDefinition
            this.localRegistry.register(tool, async (params, context) => {
              return Tracer.startActiveSpan(`mcp_tool_call:${tool.name}`, async (toolSpan) => {
                // Critical Requirement: Timeout Management (10s)
                try {
                  const result = await Promise.race([
                    client.callTool(tool.name, params),
                    new Promise((_, reject) => 
                      setTimeout(() => reject(new Error(`MCP tool ${tool.name} timed out after 10s`)), 10000)
                    )
                  ]);
                  
                  return {
                    success: true,
                    output: result,
                  };
                } catch (error: any) {
                  return {
                    success: false,
                    error: error.message || `Failed to call remote tool ${tool.name}`,
                  };
                }
              });
            });
          }
          console.log(`Discovered ${remoteTools.length} tools from MCP server: ${name}`);
        } catch (error) {
          console.error(`Failed to discover tools from MCP server ${name}:`, error);
        }
      }
    });
  }

  /**
   * Lists all available tools (local and discovered remote).
   */
  listAllTools(): ToolDefinition[] {
    return this.localRegistry.list();
  }

  /**
   * Gets tool names for planning constraints.
   */
  getAllToolNames(): string[] {
    return this.listAllTools().map(t => t.name);
  }
}

// Singleton instance
let globalRegistryManager: RegistryManager | null = null;

export function getRegistryManager(): RegistryManager {
  if (!globalRegistryManager) {
    globalRegistryManager = new RegistryManager();
  }
  return globalRegistryManager;
}
