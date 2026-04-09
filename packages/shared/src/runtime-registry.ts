/**
 * Unified Runtime Registry
 *
 * Consolidates tools, MCP, and service registries into a single source of truth.
 * Reduces duplication and drift across apps.
 *
 * @see Phase 2.2: Kill Duplicate Registries
 */

import { z } from "zod";
import { ToolDefinition } from "@repo/shared";
import { SERVICES } from "./services";
import { Logger } from "./logger";

const logger = new Logger({ serviceName: "runtime-registry" });

// ============================================================================
// TOOL REGISTRY
// Unified tool definitions used across all apps
// ============================================================================

export interface ToolRegistry {
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  register(tool: ToolDefinition): void;
  has(name: string): boolean;
}

export class UnifiedToolRegistry implements ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private static instance: UnifiedToolRegistry;

  private constructor() {}

  static getInstance(): UnifiedToolRegistry {
    if (!UnifiedToolRegistry.instance) {
      UnifiedToolRegistry.instance = new UnifiedToolRegistry();
    }
    return UnifiedToolRegistry.instance;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      logger.warn({
        message: "Tool already registered, overwriting",
        toolName: tool.name,
      });
    }
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  clear(): void {
    this.tools.clear();
  }
}

// ============================================================================
// MCP REGISTRY
// Tracks connected MCP servers and their capabilities
// ============================================================================

export interface McpServerEntry {
  name: string;
  url: string;
  status: "connected" | "disconnected" | "degraded";
  tools: string[]; // Tool names provided by this server
  lastHealthCheck?: string;
  error?: string;
}

export interface McpRegistry {
  servers: McpServerEntry[];
  getServer(name: string): McpServerEntry | undefined;
  registerServer(entry: McpServerEntry): void;
  updateStatus(
    name: string,
    status: McpServerEntry["status"],
    error?: string,
  ): void;
  getToolsForServer(name: string): string[];
  getHealthyServers(): McpServerEntry[];
}

export class UnifiedMcpRegistry implements McpRegistry {
  servers: McpServerEntry[] = [];
  private static instance: UnifiedMcpRegistry;

  private constructor() {}

  static getInstance(): UnifiedMcpRegistry {
    if (!UnifiedMcpRegistry.instance) {
      UnifiedMcpRegistry.instance = new UnifiedMcpRegistry();
    }
    return UnifiedMcpRegistry.instance;
  }

  getServer(name: string): McpServerEntry | undefined {
    return this.servers.find((s) => s.name === name);
  }

  registerServer(entry: McpServerEntry): void {
    const existing = this.servers.findIndex((s) => s.name === entry.name);
    if (existing >= 0) {
      this.servers[existing] = { ...this.servers[existing], ...entry };
    } else {
      this.servers.push(entry);
    }
  }

  updateStatus(
    name: string,
    status: McpServerEntry["status"],
    error?: string,
  ): void {
    const idx = this.servers.findIndex((s) => s.name === name);
    if (idx >= 0) {
      this.servers[idx] = {
        ...this.servers[idx],
        status,
        error,
        lastHealthCheck: new Date().toISOString(),
      };
    }
  }

  getToolsForServer(name: string): string[] {
    const server = this.getServer(name);
    return server?.tools || [];
  }

  getHealthyServers(): McpServerEntry[] {
    return this.servers.filter((s) => s.status === "connected");
  }
}

// ============================================================================
// SERVICE REGISTRY
// Unified service endpoint tracking
// ============================================================================

export interface ServiceEntry {
  name: string;
  baseUrl: string;
  healthUrl?: string;
  status: "healthy" | "degraded" | "unhealthy";
  lastHealthCheck?: string;
  latencyMs?: number;
}

export class UnifiedServiceRegistry {
  private services = new Map<string, ServiceEntry>();
  private static instance: UnifiedServiceRegistry;

  private constructor() {
    // Initialize from SERVICES constant
    this.registerService({
      name: "intention-engine",
      baseUrl: SERVICES.INTENTION_ENGINE.URL,
      healthUrl: `${SERVICES.INTENTION_ENGINE.URL}/health`,
      status: "healthy",
    });

    this.registerService({
      name: "table-stack",
      baseUrl: SERVICES.TABLESTACK.URL,
      healthUrl: `${SERVICES.TABLESTACK.URL}/health`,
      status: "healthy",
    });

    this.registerService({
      name: "open-delivery",
      baseUrl: SERVICES.OPENDELIVERY.URL,
      healthUrl: `${SERVICES.OPENDELIVERY.URL}/health`,
      status: "healthy",
    });
  }

  static getInstance(): UnifiedServiceRegistry {
    if (!UnifiedServiceRegistry.instance) {
      UnifiedServiceRegistry.instance = new UnifiedServiceRegistry();
    }
    return UnifiedServiceRegistry.instance;
  }

  registerService(entry: ServiceEntry): void {
    this.services.set(entry.name, entry);
  }

  getService(name: string): ServiceEntry | undefined {
    return this.services.get(name);
  }

  updateStatus(
    name: string,
    status: ServiceEntry["status"],
    latencyMs?: number,
  ): void {
    const service = this.services.get(name);
    if (service) {
      this.services.set(name, {
        ...service,
        status,
        latencyMs,
        lastHealthCheck: new Date().toISOString(),
      });
    }
  }

  getHealthyServices(): ServiceEntry[] {
    return Array.from(this.services.values()).filter(
      (s) => s.status === "healthy",
    );
  }

  getAllServices(): ServiceEntry[] {
    return Array.from(this.services.values());
  }
}

// ============================================================================
// RUNTIME REGISTRY FACADE
// Single entry point for all registry operations
// ============================================================================

export interface RuntimeRegistry {
  tools: ToolRegistry;
  mcp: McpRegistry;
  services: ReturnType<typeof UnifiedServiceRegistry.getInstance>;
}

export class UnifiedRuntimeRegistry implements RuntimeRegistry {
  readonly tools: ToolRegistry;
  readonly mcp: McpRegistry;
  readonly services: ReturnType<typeof UnifiedServiceRegistry.getInstance>;
  private static instance: UnifiedRuntimeRegistry;

  private constructor() {
    this.tools = UnifiedToolRegistry.getInstance();
    this.mcp = UnifiedMcpRegistry.getInstance();
    this.services = UnifiedServiceRegistry.getInstance();
  }

  static getInstance(): UnifiedRuntimeRegistry {
    if (!UnifiedRuntimeRegistry.instance) {
      UnifiedRuntimeRegistry.instance = new UnifiedRuntimeRegistry();
    }
    return UnifiedRuntimeRegistry.instance;
  }

  /**
   * Health check - verify all registries are operational
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    tools_count: number;
    mcp_servers_healthy: number;
    services_healthy: number;
  }> {
    const toolsCount = this.tools.list().length;
    const mcpHealthy = this.mcp.getHealthyServers().length;
    const servicesHealthy = this.services.getHealthyServices().length;

    return {
      healthy: toolsCount > 0 && mcpHealthy > 0 && servicesHealthy > 0,
      tools_count: toolsCount,
      mcp_servers_healthy: mcpHealthy,
      services_healthy: servicesHealthy,
    };
  }

  /**
   * Reset all registries (for testing)
   */
  reset(): void {
    (this.tools as UnifiedToolRegistry).clear();
    (this.mcp as UnifiedMcpRegistry).servers = [];
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// Direct access to registry singletons
// ============================================================================

export function getToolRegistry(): ToolRegistry {
  return UnifiedToolRegistry.getInstance();
}

export function getMcpRegistry(): McpRegistry {
  return UnifiedMcpRegistry.getInstance();
}

export function getServiceRegistry(): ReturnType<
  typeof UnifiedServiceRegistry.getInstance
> {
  return UnifiedServiceRegistry.getInstance();
}

export function getRuntimeRegistry(): RuntimeRegistry {
  return UnifiedRuntimeRegistry.getInstance();
}
