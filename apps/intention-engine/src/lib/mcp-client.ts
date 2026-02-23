import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { env } from "./config";
import { SecurityProvider } from "@repo/auth";
import { SERVICES } from "@repo/shared";
import {
  TOOLS,
  PARAMETER_ALIASES,
  ToolInput,
  ToolOutput,
  McpToolRegistry,
} from "@repo/mcp-protocol";
import { createSchemaEvolutionService } from "@repo/shared";

/**
 * MCP Client - Enhanced with Dynamic Tool Discovery and Schema Evolution
 *
 * Vercel Hobby Tier Optimization:
 * - Auto-discovers tools from SERVICES registry
 * - Parameter aliasing middleware for seamless integration
 * - Schema evolution tracking for continuous learning
 * - Plug-and-Play: New apps automatically available
 *
 * Architecture:
 * 1. Scans SERVICES registry for MCP endpoints
 * 2. Connects to each service and retrieves tool definitions
 * 3. Builds unified tool registry with parameter aliases
 * 4. Intercepts tool calls to apply parameter aliasing
 * 5. Tracks normalization failures for schema evolution
 */

// ============================================================================
// SERVICE REGISTRY ENTRY
// ============================================================================

export interface ServiceRegistryEntry {
  name: string;
  mcpUrl: string;
  apiUrl?: string;
  healthUrl?: string;
  capabilities?: string[];
}

// ============================================================================
// TOOL CALL INTERCEPTOR
// Applies parameter aliasing before tool execution
// ============================================================================

export interface ToolCallContext {
  toolName: string;
  parameters: ToolInput;
  serverName: string;
}

export interface ToolCallResult {
  success: boolean;
  output?: ToolOutput;
  error?: string;
}

// ============================================================================
// PARAMETER ALIASING MIDDLEWARE
// Resolves parameter name mismatches between LLM and MCP tools
// ============================================================================

export class ParameterAliaser {
  private aliases: Record<string, string>;
  private schemaEvolutionService: any | null = null;
  private aliasUsageCounter: Map<string, number> = new Map();

  constructor(aliases: Record<string, string> = PARAMETER_ALIASES) {
    this.aliases = aliases;
    // Lazy initialization of schema evolution service
    this.initializeSchemaEvolution();
  }

  /**
   * Initialize schema evolution service for continuous learning
   */
  private async initializeSchemaEvolution(): Promise<void> {
    try {
      // Lazy load to avoid circular dependencies
      const { redis } = await import("./redis-client");
      if (redis) {
        this.schemaEvolutionService = createSchemaEvolutionService({ redis });
        console.log("[ParameterAliaser] Schema evolution tracking enabled");
      }
    } catch (error) {
      // Silently fail - schema evolution is optional
      console.warn("[ParameterAliaser] Schema evolution not available:", error);
    }
  }

  /**
   * Track alias usage for schema evolution analysis
   */
  private trackAliasUsage(alias: string, canonical: string): void {
    const key = `${alias}->${canonical}`;
    const count = this.aliasUsageCounter.get(key) || 0;
    this.aliasUsageCounter.set(key, count + 1);

    // Log frequently used aliases for schema evolution review
    if (count > 10 && this.schemaEvolutionService) {
      console.log(
        `[ParameterAliaser] High-frequency alias detected: ${alias} -> ${canonical} (${count + 1} uses)`
      );
      // Could trigger schema evolution review here
    }
  }

  /**
   * Apply parameter aliases to tool input
   * If LLM provides `venueId` but tool expects `restaurant_id`, fix it
   */
  applyAliases(parameters: Record<string, unknown>, targetSchema?: any): Record<string, unknown> {
    const resolved: Record<string, unknown> = { ...parameters };
    let aliasApplied = false;

    for (const [alias, primary] of Object.entries(this.aliases)) {
      // If parameter exists as alias but not as primary, move it
      if (
        resolved[alias] !== undefined &&
        resolved[primary as string] === undefined
      ) {
        resolved[primary as string] = resolved[alias];
        delete resolved[alias];
        console.log(
          `[ParameterAliaser] Applied alias: ${alias} -> ${primary}`
        );
        this.trackAliasUsage(alias, primary as string);
        aliasApplied = true;
      }
    }

    // Tool-specific aliases (from tool definition)
    if (targetSchema?.parameter_aliases) {
      for (const [alias, primary] of Object.entries(
        targetSchema.parameter_aliases
      )) {
        if (
          resolved[alias] !== undefined &&
          resolved[primary as string] === undefined
        ) {
          resolved[primary as string] = resolved[alias];
          delete resolved[alias];
          console.log(
            `[ParameterAliaser] Applied tool-specific alias: ${alias} -> ${primary}`
          );
          this.trackAliasUsage(alias, primary as string);
          aliasApplied = true;
        }
      }
    }

    if (aliasApplied) {
      console.log(
        `[ParameterAliaser] Alias resolution complete. Applied ${Object.keys(resolved).length} parameters`
      );
    }

    return resolved;
  }

  /**
   * Get reverse alias (for error messages / debugging)
   */
  getReverseAlias(parameter: string): string | null {
    for (const [alias, primary] of Object.entries(this.aliases)) {
      if (primary === parameter) return alias;
    }
    return null;
  }
}

// ============================================================================
// DYNAMIC MCP CLIENT MANAGER
// Discovers and manages MCP connections
// ============================================================================

export class DynamicMcpClientManager {
  private clients: Map<string, Client> = new Map();
  private toolRegistry: Map<string, McpToolRegistry[keyof McpToolRegistry]> =
    new Map();
  private parameterAliaser: ParameterAliaser;
  private serviceRegistry: ServiceRegistryEntry[];

  constructor() {
    this.parameterAliaser = new ParameterAliaser();
    this.serviceRegistry = this.buildServiceRegistry();
  }

  /**
   * Build service registry from SERVICES and environment
   */
  private buildServiceRegistry(): ServiceRegistryEntry[] {
    const registry: ServiceRegistryEntry[] = [];

    // Add TableStack
    if (env.TABLESTACK_MCP_URL) {
      registry.push({
        name: "tablestack",
        mcpUrl: env.TABLESTACK_MCP_URL,
        apiUrl: SERVICES.TABLESTACK.API_URL,
        capabilities: ["table_management", "reservations", "waitlist"],
      });
    }

    // Add OpenDelivery
    if (env.OPENDELIVER_MCP_URL) {
      registry.push({
        name: "opendelivery",
        mcpUrl: env.OPENDELIVER_MCP_URL,
        capabilities: ["delivery_quotes", "fulfillment"],
      });
    }

    // Auto-discover: Check for additional services in environment
    // Pattern: {SERVICE_NAME}_MCP_URL
    for (const [key, value] of Object.entries(process.env)) {
      if (key.endsWith("_MCP_URL") && !["TABLESTACK", "OPENDELIVER"].some((s) => key.includes(s))) {
        const serviceName = key.replace("_MCP_URL", "").toLowerCase();
        if (!registry.some((r) => r.name === serviceName)) {
          registry.push({
            name: serviceName,
            mcpUrl: value!,
            capabilities: [], // Will be discovered dynamically
          });
        }
      }
    }

    return registry;
  }

  /**
   * Initialize all MCP clients
   */
  async initialize(): Promise<void> {
    console.log(
      `[DynamicMcpClient] Initializing ${this.serviceRegistry.length} services`
    );

    for (const service of this.serviceRegistry) {
      try {
        await this.connectToService(service);
      } catch (error) {
        console.error(
          `[DynamicMcpClient] Failed to connect to ${service.name}:`,
          error
        );
      }
    }
  }

  /**
   * Connect to a single service
   */
  private async connectToService(
    service: ServiceRegistryEntry
  ): Promise<void> {
    if (this.clients.has(service.name)) {
      console.log(
        `[DynamicMcpClient] Already connected to ${service.name}`
      );
      return;
    }

    console.log(
      `[DynamicMcpClient] Connecting to ${service.name} at ${service.mcpUrl}`
    );

    const client = await createMcpClient(service.mcpUrl);
    this.clients.set(service.name, client);

    // Discover tools from this service
    try {
      const tools = await client.listTools();
      console.log(
        `[DynamicMcpClient] Discovered ${tools.tools.length} tools from ${service.name}`
      );

      // Register tools
      for (const tool of tools.tools) {
        this.toolRegistry.set(tool.name, {
          name: tool.name,
          description: tool.description || "",
          inputSchema: tool.inputSchema,
          requires_confirmation: false, // Will be determined from metadata
          origin: service.mcpUrl,
        } as any);
      }
    } catch (error) {
      console.warn(
        `[DynamicMcpClient] Failed to list tools from ${service.name}:`,
        error
      );
    }
  }

  /**
   * Get a client by service name
   */
  getClient(serviceName: string): Client | undefined {
    return this.clients.get(serviceName);
  }

  /**
   * Get all clients
   */
  getAllClients(): Record<string, Client> {
    const result: Record<string, Client> = {};
    for (const [name, client] of this.clients.entries()) {
      result[name] = client;
    }
    return result;
  }

  /**
   * Get discovered tool registry
   */
  getToolRegistry(): Map<string, any> {
    return this.toolRegistry;
  }

  /**
   * Get the parameter aliaser for manual use
   */
  getParameterAliaser(): ParameterAliaser {
    return this.parameterAliaser;
  }

  /**
   * Execute a tool with parameter aliasing
   */
  async executeTool(
    toolName: string,
    parameters: Record<string, unknown>,
    serverName?: string
  ): Promise<ToolCallResult> {
    // Find the tool in registry
    const toolDef = this.toolRegistry.get(toolName);
    if (!toolDef) {
      return {
        success: false,
        error: `Tool ${toolName} not found in registry`,
      };
    }

    // Determine target server
    const targetServer =
      serverName || this.findToolServer(toolName);
    if (!targetServer) {
      return {
        success: false,
        error: `No server found for tool ${toolName}`,
      };
    }

    const client = this.clients.get(targetServer);
    if (!client) {
      return {
        success: false,
        error: `Not connected to server ${targetServer}`,
      };
    }

    try {
      // Apply parameter aliasing
      const resolvedParams = this.parameterAliaser.applyAliases(
        parameters,
        (toolDef as any).inputSchema
      );

      console.log(
        `[DynamicMcpClient] Executing ${toolName} on ${targetServer}`,
        { original: parameters, resolved: resolvedParams }
      );

      // Execute tool
      const result = await client.callTool({
        name: toolName,
        arguments: resolvedParams,
      });

      return {
        success: true,
        output: result as ToolOutput,
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Find which server provides a tool
   */
  private findToolServer(toolName: string): string | null {
    // Check static TOOLS registry first
    for (const [serverName, tools] of Object.entries(TOOLS)) {
      for (const [toolKey, toolDef] of Object.entries(tools as any)) {
        if ((toolDef as any).name === toolName || toolKey === toolName) {
          return serverName;
        }
      }
    }

    // Check discovered tools
    for (const [serverName, client] of this.clients.entries()) {
      // Would need to track which tools belong to which server
      // For now, return first available client
      if (client) return serverName;
    }

    return null;
  }

  /**
   * Refresh tool registry (e.g., after new service deployment)
   */
  async refreshToolRegistry(): Promise<void> {
    console.log("[DynamicMcpClient] Refreshing tool registry");
    this.toolRegistry.clear();

    for (const [name, client] of this.clients.entries()) {
      try {
        const tools = await client.listTools();
        for (const tool of tools.tools) {
          this.toolRegistry.set(tool.name, {
            name: tool.name,
            description: tool.description || "",
            inputSchema: tool.inputSchema,
            origin: name,
          } as any);
        }
      } catch (error) {
        console.error(
          `[DynamicMcpClient] Failed to refresh tools from ${name}:`,
          error
        );
      }
    }
  }
}

// ============================================================================
// LEGACY COMPATIBILITY
// Maintains backward compatibility with existing code
// ============================================================================

export async function createMcpClient(url: string) {
  // Sign a service token for authentication
  const token = await SecurityProvider.signServiceToken({
    service: "intention-engine",
    timestamp: Date.now(),
  });

  const urlWithAuth = new URL(url);
  urlWithAuth.searchParams.set("token", token);
  // Also add internal key for fallback
  urlWithAuth.searchParams.set(
    "internal_key",
    process.env.INTERNAL_SYSTEM_KEY || ""
  );

  const transport = new SSEClientTransport(urlWithAuth);
  const client = new Client(
    {
      name: "intention-engine-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  await client.connect(transport);
  return client;
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let defaultManager: DynamicMcpClientManager | null = null;

function getManager(): DynamicMcpClientManager {
  if (!defaultManager) {
    defaultManager = new DynamicMcpClientManager();
  }
  return defaultManager;
}

/**
 * Get MCP Clients - Enhanced with dynamic discovery
 * Returns both legacy named clients and dynamic manager
 */
export async function getMcpClients(): Promise<{
  tablestack?: Client;
  opendeliver?: Client;
  manager: DynamicMcpClientManager;
}> {
  const manager = getManager();

  // Initialize if not already done
  if (Object.keys(manager.getAllClients()).length === 0) {
    await manager.initialize();
  }

  // Return legacy compatibility interface
  const clients = manager.getAllClients();

  return {
    tablestack: clients.tablestack,
    opendeliver: clients.opendelivery || clients.opendeliver,
    manager,
  };
}

/**
 * Execute a tool with automatic parameter aliasing
 * Convenience function for single tool calls
 */
export async function executeTool(
  toolName: string,
  parameters: Record<string, unknown>,
  serverName?: string
): Promise<ToolCallResult> {
  const manager = getManager();
  return manager.executeTool(toolName, parameters, serverName);
}

/**
 * Get the parameter aliaser for manual use
 */
export function getParameterAliaser(): ParameterAliaser {
  return getManager().getParameterAliaser();
}
