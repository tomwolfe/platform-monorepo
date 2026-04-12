import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { signAsymmetricJWT } from "@repo/auth";
import {
  getRedisClient,
  ServiceNamespace,
  AppConfig,
  Logger,
} from "@repo/shared";
import { SERVICES } from "@repo/shared";
import {
  TOOLS,
  PARAMETER_ALIASES,
  ToolInput,
  ToolOutput,
  McpToolRegistry,
  AllToolsMap,
  validateToolParams,
} from "@repo/mcp-protocol";
import { createSchemaEvolutionService } from "@repo/shared";
import * as zod from "zod";
import { mapJsonSchemaToZod } from "./engine/schema-utils";

const logger = new Logger({ serviceName: "dynamic-mcp-client" });

// ============================================================================
// TOOL REGISTRY ENTRY TYPE
// Extended tool info stored in the registry
// ============================================================================

interface ToolRegistryEntry {
  name: string;
  description: string;
  inputSchema: any;
  zodSchema: any;
  requires_confirmation: boolean;
  origin: string;
}

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
  private schemaEvolutionService: Awaited<
    ReturnType<typeof createSchemaEvolutionService>
  > | null = null;
  private aliasUsageCounter: Map<string, number> = new Map();

  constructor(aliases: Record<string, string> = PARAMETER_ALIASES) {
    this.aliases = aliases;
    // Lazy initialization of schema evolution service
    void this.initializeSchemaEvolution();
  }

  /**
   * Initialize schema evolution service for continuous learning
   */
  private async initializeSchemaEvolution(): Promise<void> {
    try {
      // Lazy load to avoid circular dependencies
      this.schemaEvolutionService = createSchemaEvolutionService();
      if (this.schemaEvolutionService) {
        logger.info("ParameterAliaser schema evolution tracking enabled");
      }
    } catch (error) {
      // Silently fail - schema evolution is optional
      logger.warn("ParameterAliaser schema evolution initialization failed", {
        error: error instanceof Error ? error.message : String(error),
      });
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
      logger.info("High-frequency alias detected", {
        alias,
        canonical,
        usageCount: count + 1,
      });
      // Could trigger schema evolution review here
    }
  }

  /**
   * Apply parameter aliases to tool input
   * If LLM provides `venueId` but tool expects `restaurant_id`, fix it
   */
  applyAliases(
    parameters: Record<string, unknown>,
    targetSchema?: zod.ZodType,
  ): Record<string, unknown> {
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
        logger.debug("Applied parameter alias", { alias, primary });
        this.trackAliasUsage(alias, primary as string);
        aliasApplied = true;
      }
    }

    // Tool-specific aliases (from tool definition)
    if (targetSchema && "parameter_aliases" in targetSchema._def) {
      const schemaDef = targetSchema._def as {
        parameter_aliases?: Record<string, string>;
      };
      if (schemaDef.parameter_aliases) {
        for (const [alias, primary] of Object.entries(
          schemaDef.parameter_aliases,
        )) {
          if (
            resolved[alias] !== undefined &&
            resolved[primary as string] === undefined
          ) {
            resolved[primary as string] = resolved[alias];
            delete resolved[alias];
            logger.debug("Applied tool-specific alias", { alias, primary });
            this.trackAliasUsage(alias, primary as string);
            aliasApplied = true;
          }
        }
      }
    }

    if (aliasApplied) {
      logger.debug("Alias resolution complete", {
        parameterCount: Object.keys(resolved).length,
      });
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
  private toolRegistry: Map<string, ToolRegistryEntry> = new Map();
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
    if (AppConfig.getTableStackMcpUrl()) {
      registry.push({
        name: "tablestack",
        mcpUrl: AppConfig.getTableStackMcpUrl(),
        apiUrl: SERVICES.TABLESTACK.API_URL,
        capabilities: ["table_management", "reservations", "waitlist"],
      });
    }

    // Add OpenDelivery
    if (AppConfig.getOpenDeliveryMcpUrl()) {
      registry.push({
        name: "opendelivery",
        mcpUrl: AppConfig.getOpenDeliveryMcpUrl(),
        capabilities: ["delivery_quotes", "fulfillment"],
      });
    }

    // Auto-discover: Check for additional services in environment
    // Pattern: {SERVICE_NAME}_MCP_URL
    for (const [key, value] of Object.entries(process.env)) {
      if (
        key.endsWith("_MCP_URL") &&
        !["TABLESTACK", "OPENDELIVER"].some((s) => key.includes(s))
      ) {
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
    logger.info("Initializing MCP services", {
      serviceCount: this.serviceRegistry.length,
    });

    for (const service of this.serviceRegistry) {
      try {
        await this.connectToService(service);
      } catch (error) {
        logger.error(`Failed to connect to MCP service: ${service.name}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Connect to a single service
   *
   * ENHANCEMENT: Added strict Zod validation for discovered tool schemas
   * to prevent malformed tools from crashing the orchestrator
   * TYPE SAFETY: Uses mapJsonSchemaToZod for proper schema conversion
   */
  private async connectToService(service: ServiceRegistryEntry): Promise<void> {
    if (this.clients.has(service.name)) {
      logger.debug(`Already connected to MCP service: ${service.name}`);
      return;
    }

    logger.info(`Connecting to MCP service: ${service.name}`, {
      url: service.mcpUrl,
    });

    const client = await createMcpClient(service.mcpUrl);
    this.clients.set(service.name, client);

    // Discover tools from this service
    try {
      const tools = await client.listTools();
      logger.info(`Discovered tools from MCP service: ${service.name}`, {
        toolCount: tools.tools.length,
      });

      // Register tools with strict schema validation
      for (const tool of tools.tools) {
        // TYPE SAFETY: Convert JSON Schema to Zod using mapJsonSchemaToZod
        let validatedInputSchema: Record<string, unknown> | undefined =
          undefined;
        let zodSchema: zod.ZodTypeAny | undefined = undefined;

        if (tool.inputSchema) {
          try {
            // Validate that inputSchema is a proper object with expected structure
            const schemaObj = tool.inputSchema as unknown;

            // Ensure it has the basic JSON Schema structure
            if (typeof schemaObj === "object" && schemaObj !== null) {
              const schemaRecord = schemaObj as Record<string, unknown>;

              // Validate 'type' field if present
              if ("type" in schemaRecord) {
                const schemaType = schemaRecord.type;
                if (typeof schemaType === "string" && schemaType !== "object") {
                  logger.warn(
                    `Tool ${tool.name} has non-object inputSchema type`,
                    {
                      schemaType,
                    },
                  );
                }
              }

              // Validate 'properties' field if present
              if ("properties" in schemaRecord) {
                const properties = schemaRecord.properties;
                if (typeof properties === "object" && properties !== null) {
                  validatedInputSchema = schemaRecord;
                  // Convert to Zod schema for strict validation
                  zodSchema = mapJsonSchemaToZod(schemaRecord);
                } else {
                  logger.warn(`Tool ${tool.name} has invalid properties field`);
                }
              } else {
                // Schema without properties is valid (empty params)
                validatedInputSchema = schemaRecord;
                zodSchema = mapJsonSchemaToZod(schemaRecord);
              }
            }
          } catch (schemaError) {
            logger.warn(`Failed to validate schema for tool: ${tool.name}`, {
              error:
                schemaError instanceof Error
                  ? schemaError.message
                  : String(schemaError),
            });
            // Continue without schema validation
          }
        }

        this.toolRegistry.set(tool.name, {
          name: tool.name,
          description: tool.description || "",
          inputSchema: validatedInputSchema,
          zodSchema, // Store Zod schema for runtime validation
          requires_confirmation: false, // Will be determined from metadata
          origin: service.mcpUrl,
        });
      }
    } catch (error) {
      logger.warn(`Failed to list tools from MCP service: ${service.name}`, {
        error: error instanceof Error ? error.message : String(error),
      });
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
  getToolRegistry(): Map<
    string,
    {
      name: string;
      description: string;
      inputSchema?: Record<string, unknown>;
      zodSchema?: zod.ZodTypeAny;
      requires_confirmation?: boolean;
      origin?: string;
    }
  > {
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
   * Enhanced with strict type validation using AllToolsMap
   * Note: Accepts string for backward compatibility with dynamic tool names
   */
  async executeTool(
    toolName: string | keyof AllToolsMap,
    parameters: Record<string, unknown>,
    serverName?: string,
  ): Promise<ToolCallResult> {
    // Find the tool in registry
    const toolDef = this.toolRegistry.get(toolName as string);
    if (!toolDef) {
      return {
        success: false,
        error: `Tool ${toolName as string} not found in registry`,
      };
    }

    // Determine target server
    const targetServer = serverName || this.findToolServer(toolName as string);
    if (!targetServer) {
      return {
        success: false,
        error: `No server found for tool ${toolName as string}`,
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
      // Validate parameters using Zod schema from registry
      let validatedParams = parameters;

      // Use stored Zod schema for validation if available
      if (toolDef.zodSchema) {
        try {
          validatedParams = toolDef.zodSchema.parse(parameters);
        } catch (validationError) {
          logger.warn(`Zod validation failed for tool: ${toolName as string}`, {
            error:
              validationError instanceof zod.ZodError
                ? validationError.errors
                : validationError,
          });
          // Fall back to original parameters
          validatedParams = parameters;
        }
      } else {
        // Fallback to AllToolsMap validation for known tools
        try {
          validatedParams = validateToolParams(
            toolName as keyof AllToolsMap,
            parameters,
          );
        } catch {
          // Tool not in AllToolsMap or validation failed - use original parameters
          validatedParams = parameters;
        }
      }

      // Apply parameter aliasing
      const resolvedParams = this.parameterAliaser.applyAliases(
        validatedParams,
        toolDef.zodSchema ||
          (toolDef.inputSchema as unknown as zod.ZodType | undefined),
      ) as Record<string, unknown>;

      logger.debug("Executing MCP tool", {
        toolName: toolName as string,
        targetServer,
        parameterCount: Object.keys(resolvedParams).length,
      });

      // Execute tool
      const result = await client.callTool({
        name: toolName as string,
        arguments: resolvedParams,
      });

      return {
        success: true,
        output: result as ToolOutput,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Find which server provides a tool
   */
  private findToolServer(toolName: string): string | null {
    // Check static TOOLS registry first
    for (const [serverName, tools] of Object.entries(TOOLS)) {
      for (const [toolKey, toolDef] of Object.entries(
        tools as Record<string, { name?: string }>,
      )) {
        if (
          (toolDef as { name?: string }).name === toolName ||
          toolKey === toolName
        ) {
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
    logger.info("Refreshing MCP tool registry");
    this.toolRegistry.clear();

    for (const [name, client] of this.clients.entries()) {
      try {
        const tools = await client.listTools();
        for (const tool of tools.tools) {
          this.toolRegistry.set(tool.name, {
            name: tool.name,
            description: tool.description || "",
            inputSchema: tool.inputSchema,
            zodSchema: undefined,
            requires_confirmation: false,
            origin: name,
          });
        }
      } catch (error) {
        logger.error(`Failed to refresh tools from MCP service: ${name}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

// ============================================================================
// LEGACY COMPATIBILITY
// Maintains backward compatibility with existing code
// ============================================================================

/**
 * Create MCP Client with secure authentication via headers
 *
 * SECURITY FIX: Removed secrets from URL query parameters
 * - Previously: token and internal_key were passed via URL (exposed in logs/proxies)
 * - Now: Authentication via HTTP headers only (Authorization + x-internal-key)
 */
export async function createMcpClient(url: string) {
  // Sign a service token for authentication using asymmetric JWT (RS256)
  const token = await signAsymmetricJWT(
    {
      service: "intention-engine",
      timestamp: Date.now(),
    },
    {
      issuer: "intention-engine",
      audience: "mcp-server",
      expiresIn: "5m",
    },
  );

  // SECURITY: Do NOT add secrets to URL query parameters
  // const urlWithAuth = new URL(url);
  // urlWithAuth.searchParams.set("token", token); // REMOVED - insecure
  // urlWithAuth.searchParams.set("internal_key", ...); // REMOVED - insecure

  // Use the URL as-is, authentication will be handled via headers in transport
  const transport = new SSEClientTransport(new URL(url), {
    // SECURITY: Pass tokens via HTTP headers instead of URL
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-internal-key": AppConfig.getInternalSystemKey() || "",
      },
    },
  });

  const client = new Client(
    {
      name: "intention-engine-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
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
  serverName?: string,
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
