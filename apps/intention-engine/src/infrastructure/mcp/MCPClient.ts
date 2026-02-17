import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { ToolDefinition } from "../../lib/engine/types";
import { z } from "zod";
import { mapJsonSchemaToZod } from "../../lib/engine/schema-utils";
import { mcpConfig } from "../../lib/mcp-config";
import { PARAMETER_ALIASES as shared_aliases, ToolInput, ToolOutput } from "@repo/mcp-protocol";
import { CircuitBreaker, CircuitBreakerError, CircuitState } from "./CircuitBreaker";
import { RealtimeService } from "@repo/shared";

/**
 * MCPClient connects to remote MCP servers and maps their tools
 * to the engine's internal ToolDefinition format.
 *
 * Phase 4: Includes circuit breaker protection for resilience.
 * Vercel Hobby Tier: Implements AbortController timeout protection (8s limit).
 */
export class MCPClient {
  private client: Client;
  private transport: SSEClientTransport;
  private serverUrl: string;
  private circuitBreaker: CircuitBreaker;
  private abortController: AbortController | null = null;
  private toolTimeoutMs: number = 8000; // 8 seconds for Vercel Hobby Tier

  constructor(serverUrl: string, circuitBreakerConfig?: { serviceName?: string }) {
    this.serverUrl = serverUrl;
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

    // Initialize circuit breaker for this server
    this.circuitBreaker = new CircuitBreaker({
      serviceName: circuitBreakerConfig?.serviceName || "mcp-server",
      serverUrl,
    });
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
   * Get circuit breaker status for observability
   */
  getCircuitBreakerStatus() {
    return this.circuitBreaker.getStatus();
  }

  /**
   * Set trace ID for distributed tracing correlation
   */
  setTraceId(traceId: string) {
    this.circuitBreaker.setTraceId(traceId);
  }

  /**
   * Lists tools from the remote MCP server and converts them to Engine ToolDefinitions.
   */
  async listTools(): Promise<ToolDefinition[]> {
    const response = await this.client.listTools();
    return response.tools.map((tool) => this.mapMcpToolToEngineTool(tool));
  }

  /**
   * Calls a tool on the remote MCP server with circuit breaker protection and exponential backoff retry.
   * Phase 4: Circuit breaker fails fast when downstream service degrades.
   * Vercel Hobby Tier: Implements AbortController timeout protection (8s limit).
   */
  async callTool(name: string, args: ToolInput, signal?: AbortSignal): Promise<ToolOutput> {
    return this.circuitBreaker.execute(async () => {
      return this.withRetry(async (attemptAbortSignal: AbortSignal) => {
        // Create AbortController for this tool call with timeout
        this.abortController = new AbortController();
        const timeoutId = setTimeout(() => {
          this.abortController?.abort();
        }, this.toolTimeoutMs);

        try {
          // Combine external signal with internal timeout
          const combinedSignal = this.createCombinedSignal([
            signal,
            this.abortController.signal,
            attemptAbortSignal
          ].filter(Boolean) as AbortSignal[]);

          // Note: MCP SDK callTool doesn't directly support AbortSignal
          // We use Promise.race to implement timeout-based cancellation
          const result = await Promise.race([
            this.client.callTool({
              name,
              arguments: args,
            }),
            new Promise<ToolOutput>((_, reject) => {
              combinedSignal.addEventListener('abort', () => {
                reject(new Error('AbortError: Tool call cancelled'));
              });
            })
          ]);
          
          clearTimeout(timeoutId);
          return result as ToolOutput;
        } catch (error: any) {
          clearTimeout(timeoutId);
          
          // Handle timeout/abort as "Service Degraded"
          if (error.message.includes('AbortError') || error.message.includes('cancelled') || this.abortController?.signal.aborted) {
            console.warn(`[MCPClient] Tool ${name} timed out after ${this.toolTimeoutMs}ms - Service Degraded`);
            
            // Publish "Service Degraded" event to Ably for observability
            await RealtimeService.publishNervousSystemEvent('ServiceDegraded', {
              serviceName: this.circuitBreaker.getServiceName(),
              toolName: name,
              reason: 'timeout',
              timeoutMs: this.toolTimeoutMs,
              timestamp: new Date().toISOString(),
            }).catch(err => console.error('Failed to publish ServiceDegraded event:', err));
            
            // Trigger circuit breaker to open
            this.circuitBreaker.recordFailure();
            
            throw new CircuitBreakerError(`Service Degraded: ${name} timed out`, CircuitState.CLOSED);
          }
          
          throw error;
        } finally {
          this.abortController = null;
        }
      });
    });
  }

  /**
   * Combines multiple AbortSignals into one.
   */
  private createCombinedSignal(signals: AbortSignal[]): AbortSignal {
    if (signals.length === 0) {
      return new AbortController().signal;
    }
    if (signals.length === 1) {
      return signals[0];
    }

    const controller = new AbortController();
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort();
        return controller.signal;
      }
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    return controller.signal;
  }

  /**
   * Exponential backoff with jitter retry strategy.
   * Supports AbortSignal for cancellation propagation.
   */
  private async withRetry<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    maxAttempts: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    let lastError: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptController = new AbortController();
      try {
        return await fn(attemptController.signal);
      } catch (error: any) {
        lastError = error;
        if (attempt === maxAttempts) break;
        
        // Don't retry if aborted
        if (error.name === 'AbortError' || attemptController.signal.aborted) {
          throw error;
        }

        // Exponential backoff: baseDelay * 2^(attempt-1) + jitter
        const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  /**
   * Maps an MCP tool definition to the engine's ToolDefinition.
   */
  private mapMcpToolToEngineTool(tool: McpTool): ToolDefinition {
    // Attempt to derive return_schema from non-standard MCP metadata if available
    const return_schema = (tool as any).outputSchema || (tool as any).returnSchema || {};
    
    const confirmationKeywords = ["book", "pay", "reserve", "buy", "send", "schedule", "delete", "remove", "dispatch", "deliver"];
    const requires_confirmation = 
      confirmationKeywords.some(keyword => tool.name.toLowerCase().includes(keyword)) ||
      tool.name.toLowerCase().startsWith("delete_") ||
      tool.name.toLowerCase().startsWith("remove_");

    // Semantic Parameter Aliases: Bridge common LLM naming to specific tool requirements
    const parameter_aliases: Record<string, string> = {
      "reservation_time": "time",
      "booking_time": "time",
      "party_size": "guests",
      "number_of_people": "guests",
      "location_name": "query",
      "search_query": "query",
      "contact_name": "name",
      "customer_name": "name",
      "order_summary": "items",
      "phone_number": "phone",
      "email_address": "email",
      ...mcpConfig.parameter_aliases, // Use centralized aliases
      ...shared_aliases,
      "guestEmail": "email",
      "target_destination": "delivery_address",
      "source_location": "pickup_address",
      "user_id": "customer_id",
      "product_id": "item_id"
    };

    return {
      name: tool.name,
      version: "1.0.0",
      description: tool.description || "",
      inputSchema: {
        type: "object",
        properties: (tool.inputSchema as any).properties || {},
        required: (tool.inputSchema as any).required || [],
      },
      return_schema: return_schema as Record<string, unknown>,
      parameter_aliases,
      timeout_ms: 30000,
      requires_confirmation: (tool as any).requiresConfirmation ?? (tool as any).requires_confirmation ?? requires_confirmation,
      category: "external",
      origin: this.serverUrl,
    };
  }

  public mapJsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
    return mapJsonSchemaToZod(schema);
  }
}
