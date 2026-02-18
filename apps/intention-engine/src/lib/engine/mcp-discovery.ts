/**
 * Dynamic Tool Discovery - MCP Integration
 * 
 * Fetches tools from registered MCP servers and dynamically populates
 * the LLM's system prompt with available capabilities.
 * 
 * This enables the IntentionEngine to automatically "learn" new capabilities
 * from table-stack and open-delivery services without manual updates.
 */

import { getMcpClients } from "@/lib/mcp-client";
import { ToolDefinition } from "@/lib/engine/types";
import { TOOLS, listTools } from "@/lib/tools/registry";

// ============================================================================
// DISCOVERED TOOL CACHE
// Cache MCP tools to avoid repeated discovery calls
// ============================================================================

interface DiscoveredToolCache {
  tools: Map<string, ToolDefinition>;
  discoveredAt: number;
  ttlMs: number;
}

const DISCOVERY_CACHE: DiscoveredToolCache = {
  tools: new Map(),
  discoveredAt: 0,
  ttlMs: 24 * 60 * 60 * 1000, // 24 hours cache - tools don't change unless code is deployed
};

// ============================================================================
// DISCOVERY RESULT
// ============================================================================

export interface DiscoveryResult {
  localTools: ToolDefinition[];
  discoveredTools: ToolDefinition[];
  allTools: ToolDefinition[];
  discoveryLatencyMs: number;
  fromCache: boolean;
  error?: string;
}

// ============================================================================
// DISCOVER MCP TOOLS
// Fetches tools from all registered MCP servers
// ============================================================================

export async function discoverMcpTools(
  options: {
    useCache?: boolean;
    timeoutMs?: number;
  } = {}
): Promise<DiscoveryResult> {
  const startTime = Date.now();
  const { useCache = true, timeoutMs = 5000 } = options;

  // Check cache
  if (useCache && !isCacheExpired()) {
    console.log("[MCP Discovery] Using cached tools");
    const cachedTools = Array.from(DISCOVERY_CACHE.tools.values());
    return {
      localTools: listTools(),
      discoveredTools: cachedTools,
      allTools: [...listTools(), ...cachedTools],
      discoveryLatencyMs: 0,
      fromCache: true,
    };
  }

  const { manager } = await getMcpClients();
  const discoveredTools: ToolDefinition[] = [];
  const errors: string[] = [];

  // Get discovered tools from manager
  const toolRegistry = manager.getToolRegistry();

  for (const [toolName, toolDef] of toolRegistry.entries()) {
    // Skip if already in local registry
    if (TOOLS.has(toolName)) {
      continue;
    }

    try {
      // Convert to ToolDefinition
      const newToolDef: ToolDefinition = {
        name: toolName,
        version: "1.0.0",
        description: (toolDef as any).description || `Remote tool`,
        inputSchema: (toolDef as any).inputSchema || {},
        return_schema: (toolDef as any).outputSchema || {},
        parameter_aliases: {},
        timeout_ms: 30000,
        requires_confirmation: toolName.toLowerCase().includes("book") ||
                               toolName.toLowerCase().includes("reserve") ||
                               toolName.toLowerCase().includes("pay"),
        category: "external",
        origin: (toolDef as any).origin || "mcp",
      };

      discoveredTools.push(newToolDef);
      console.log(
        `[MCP Discovery] Discovered ${toolName} from ${newToolDef.origin}`
      );
    } catch (error: any) {
      const errorMsg = `Failed to process tool ${toolName}: ${error.message}`;
      console.error(`[MCP Discovery] ${errorMsg}`);
      errors.push(errorMsg);
    }
  }

  // Update cache
  DISCOVERY_CACHE.tools = new Map(discoveredTools.map(t => [t.name, t]));
  DISCOVERY_CACHE.discoveredAt = Date.now();

  const allTools = [...listTools(), ...discoveredTools];

  console.log(
    `[MCP Discovery] Complete: ${discoveredTools.length} tools discovered ` +
    `(${allTools.length} total) in ${Date.now() - startTime}ms`
  );

  return {
    localTools: listTools(),
    discoveredTools,
    allTools,
    discoveryLatencyMs: Date.now() - startTime,
    fromCache: false,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}

// ============================================================================
// BUILD SYSTEM PROMPT
// Generates LLM system prompt with dynamic tool capabilities
// ============================================================================

export async function buildSystemPrompt(
  options: {
    includeDiscoveredTools?: boolean;
    includeConfirmationFlags?: boolean;
    includeParameterSchemas?: boolean;
    userLocation?: { lat: number; lng: number };
    additionalContext?: string;
  } = {}
): Promise<string> {
  const {
    includeDiscoveredTools = true,
    includeConfirmationFlags = true,
    includeParameterSchemas = false,
    userLocation,
    additionalContext,
  } = options;

  const discoveryResult = includeDiscoveredTools
    ? await discoverMcpTools()
    : { allTools: listTools(), fromCache: true };

  const tools = discoveryResult.allTools;

  // Build tool capabilities section
  const toolCapabilities = tools.map(tool => {
    let description = `- ${tool.name}: ${tool.description}`;
    
    if (includeConfirmationFlags && tool.requires_confirmation) {
      description += " [REQUIRES CONFIRMATION]";
    }
    
    if (tool.origin) {
      description += ` (from ${tool.origin})`;
    }
    
    return description;
  }).join("\n");

  // Build parameter schemas if requested
  const parameterSchemas = includeParameterSchemas
    ? tools.map(tool => {
        const params = Object.entries(
          (tool.inputSchema as any).properties || {}
        )
          .map(([name, schema]: [string, any]) => {
            const type = schema.type || "any";
            const required = (tool.inputSchema as any).required?.includes(name)
              ? " (required)"
              : "";
            const desc = schema.description ? ` - ${schema.description}` : "";
            return `    - ${name}: ${type}${required}${desc}`;
          })
          .join("\n");
        
        return `${tool.name}:\n${params}`;
      }).join("\n\n")
    : "";

  // Location context
  const locationContext = userLocation
    ? `The user is currently at latitude ${userLocation.lat}, longitude ${userLocation.lng}. Use these coordinates for location-based requests.`
    : "The user's location is unknown. Ask for clarification if location is needed.";

  // Build the complete prompt
  const prompt = `You are an IntentionEngine - a specialized AI for orchestrating actions across multiple services.

## YOUR CAPABILITIES
You have access to the following tools. Use them to fulfill user requests:

${toolCapabilities}

${includeParameterSchemas ? `## TOOL PARAMETER SCHEMAS\n${parameterSchemas}\n` : ""}

## IMPORTANT RULES
1. **Tool Usage**: If a user's request matches a tool's capabilities, USE THE TOOL. Do not claim inability to perform actions that your tools enable.
2. **Confirmation**: Tools marked [REQUIRES CONFIRMATION] need explicit user approval before execution.
3. **Parameter Mapping**: Map user inputs to tool parameters accurately. Use aliases when available.
4. **Error Handling**: If a tool fails, acknowledge the error and attempt to replan or suggest alternatives.
5. **Location**: ${locationContext}

${additionalContext || ""}

## RESPONSE FORMAT
When using tools, provide:
1. Tool name
2. Required parameters
3. Expected outcome

Example:
"I'll book a table at \${restaurantName} for \${partySize} people at \${time}. This requires your confirmation."

Remember: You ARE capable of performing these actions through the available tools.`;

  return prompt;
}

// ============================================================================
// GET TOOL BY NAME (WITH DISCOVERY)
// Looks up tools in local registry first, then discovered tools
// ============================================================================

export async function getToolByName(name: string): Promise<ToolDefinition | undefined> {
  // Check local registry first
  const localTool = TOOLS.get(name);
  if (localTool) {
    return localTool;
  }

  // Check discovered tools cache
  const discoveredTool = DISCOVERY_CACHE.tools.get(name);
  if (discoveredTool) {
    return discoveredTool;
  }

  // Force discovery if not in cache
  const result = await discoverMcpTools({ useCache: false });
  return result.allTools.find(t => t.name === name);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function isCacheExpired(): boolean {
  return Date.now() - DISCOVERY_CACHE.discoveredAt > DISCOVERY_CACHE.ttlMs;
}

export function clearDiscoveryCache(): void {
  DISCOVERY_CACHE.tools.clear();
  DISCOVERY_CACHE.discoveredAt = 0;
  console.log("[MCP Discovery] Cache cleared");
}

export function getDiscoveryCacheStatus(): {
  toolCount: number;
  ageMs: number;
  isExpired: boolean;
} {
  const age = Date.now() - DISCOVERY_CACHE.discoveredAt;
  return {
    toolCount: DISCOVERY_CACHE.tools.size,
    ageMs: age,
    isExpired: age > DISCOVERY_CACHE.ttlMs,
  };
}
