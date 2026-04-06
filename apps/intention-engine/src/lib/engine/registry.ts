import { ToolRegistry, getToolRegistry } from "./tools/registry";
import { MCPClient } from "../../infrastructure/mcp/MCPClient";
import { ToolDefinition } from "./types";
import { Tracer } from "./tracing";
import { getMemoryClient } from "./memory";
import { mcpConfig } from "../mcp-config";
import { Logger } from "@repo/shared";
import { SERVICES } from "@repo/shared/services";

import { listTools as listDomainTools } from "../tools/registry";

const logger = new Logger({ serviceName: "intention-engine" });

/**
 * RegistryManager coordinates local and remote tool discovery.
 *
 * PHASE 4 CONSOLIDATION:
 * - Removed hardcoded tool definitions
 * - discoverRemoteTools now iterates over SERVICES from @repo/shared
 * - Automatically hits /api/mcp/tools for every registered service
 */
export class RegistryManager {
  private localRegistry: ToolRegistry;
  private mcpClients: Map<string, MCPClient> = new Map();

  constructor() {
    this.localRegistry = getToolRegistry();

    // Register Domain Tools from tools/registry.ts
    // This is the sole provider of local tools
    const domainTools = listDomainTools();
    for (const tool of domainTools) {
      if (!this.localRegistry.has(tool.name)) {
        this.localRegistry.register(tool, async (params, _context) => {
          const result = await tool.execute(params);
          return {
            success: result.success,
            output: result.result,
            error: result.error
          };
        });
      }
    }

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

    // OpenDeliver uses mcpConfig for transport
    if (mcpConfig.transport.opendeliver) {
      this.mcpClients.set("opendeliver", new MCPClient(mcpConfig.transport.opendeliver));
    }

    if (process.env.TABLESTACK_MCP_URL) {
      this.mcpClients.set("tablestack", new MCPClient(process.env.TABLESTACK_MCP_URL));
    }
  }

  /**
   * Discovers tools from all connected MCP servers and populates the local registry.
   *
   * PHASE 4 CONSOLIDATION:
   * - Iterates over SERVICES defined in @repo/shared/services
   * - Automatically hits /api/mcp/tools endpoint for every registered service
   * - Falls back to existing MCP client instances for legacy servers
   */
  async discoverRemoteTools(): Promise<void> {
    const memory = getMemoryClient();

    return Tracer.startActiveSpan("discover_remote_tools", async (span) => {
      // Phase 4: Discover tools from SERVICES defined in @repo/shared
      await this.discoverServicesViaMCP();

      // Legacy: Discover tools from hardcoded MCP clients
      await this.discoverLegacyMcpClients();
    });
  }

  /**
   * Discover tools from SERVICES defined in @repo/shared/services
   * Iterates over each service and hits /api/mcp/tools endpoint
   */
  private async discoverServicesViaMCP(): Promise<void> {
    const memory = getMemoryClient();

    for (const [serviceName, serviceConfig] of Object.entries(SERVICES)) {
      // Skip Intention Engine (we are the intention engine)
      if (serviceName === "INTENTION_ENGINE") continue;

      // Get MCP URL from service config
      const mcpUrl = (serviceConfig as any).MCP_URL;
      if (!mcpUrl) {
        logger.debug({
          message: `[RegistryManager] Service ${serviceName} has no MCP_URL, skipping`,
        });
        continue;
      }

      const serverKey = `circuit_breaker:mcp:${serviceName.toLowerCase()}`;

      try {
        // Create MCP client for this service
        let client = this.mcpClients.get(serviceName.toLowerCase());
        if (!client) {
          client = new MCPClient(mcpUrl);
          this.mcpClients.set(serviceName.toLowerCase(), client);
        }

        await client.connect();
        const remoteTools = await client.listTools();

        for (const tool of remoteTools) {
          this.registerRemoteTool(tool, async (params, context) => {
            return Tracer.startActiveSpan(`mcp_tool_call:${tool.name}`, async (toolSpan) => {
              // Check Circuit Breaker
              const failCount = await memory.getCounter(serverKey);
              if (failCount >= 3) {
                return {
                  success: false,
                  error: `Circuit breaker tripped for MCP server: ${serviceName}. Too many recent failures.`,
                };
              }

              try {
                const paramsWithTrace: Record<string, unknown> = {
                  ...params,
                  _trace_id: context.executionId
                };
                const result = await client!.callTool(tool.name, paramsWithTrace, context.abortSignal);

                return {
                  success: true,
                  output: result,
                };
              } catch (error: unknown) {
                // Increment Failure Counter
                await memory.incrementCounter(serverKey, 60);

                return {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                };
              }
            });
          });
        }

        logger.info({
          message: `[RegistryManager] Discovered ${remoteTools.length} tools from service: ${serviceName}`,
        });
      } catch (error) {
        logger.error({
          message: `[RegistryManager] Failed to discover tools from service ${serviceName}`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Legacy MCP client discovery for backward compatibility
   * Uses existing hardcoded MCP client instances
   */
  private async discoverLegacyMcpClients(): Promise<void> {
    const memory = getMemoryClient();
    const clients = Array.from(this.mcpClients.entries());

    for (const [name, client] of clients) {
      try {
        await client.connect();
        const remoteTools = await client.listTools();
        const serverKey = `circuit_breaker:mcp:${name}`;

        for (const tool of remoteTools) {
          this.registerRemoteTool(tool, async (params, context) => {
            return Tracer.startActiveSpan(`mcp_tool_call:${tool.name}`, async (toolSpan) => {
              // Check Circuit Breaker
              const failCount = await memory.getCounter(serverKey);
              if (failCount >= 3) {
                return {
                  success: false,
                  error: `Circuit breaker tripped for MCP server: ${name}. Too many recent failures.`,
                };
              }

              try {
                const paramsWithTrace: Record<string, unknown> = {
                  ...params,
                  _trace_id: context.executionId
                };
                const result = await client.callTool(tool.name, paramsWithTrace, context.abortSignal);

                return {
                  success: true,
                  output: result,
                };
              } catch (error: unknown) {
                // Increment Failure Counter
                await memory.incrementCounter(serverKey, 60);

                return {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                };
              }
            });
          });
        }

        logger.info({
          message: `[RegistryManager] Discovered ${remoteTools.length} tools from MCP client: ${name}`,
        });
      } catch (error) {
        logger.error({
          message: `[RegistryManager] Failed to discover tools from MCP client ${name}`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Register a remote tool in the local registry with a wrapper implementation
   */
  private registerRemoteTool(
    tool: ToolDefinition,
    executor: (params: Record<string, unknown>, context: any) => Promise<{ success: boolean; output?: unknown; error?: string }>
  ): void {
    this.localRegistry.register(tool, executor);
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
