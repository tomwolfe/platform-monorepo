/**
 * MCP Server Factory - DRY SSE Transport Setup
 *
 * Extracts the common MCP SSE transport server setup used across
 * table-stack and open-delivery satellite apps.
 *
 * Features:
 * - SSE transport with GET/POST handlers
 * - SecurityProvider token validation
 * - Trace ID injection for observability
 * - Request validation
 *
 * Usage:
 * ```typescript
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { createMcpServerRoutes } from "@repo/mcp-protocol/server";
 *
 * const server = new McpServer({ name: "my-server", version: "1.0.0" });
 *
 * // Register tools...
 * server.tool("my_tool", "Description", schema, handler);
 *
 * export const { GET, POST } = createMcpServerRoutes(server);
 * ```
 *
 * @package @repo/mcp-protocol
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { SecurityProvider } from "@repo/auth";
import { randomUUID } from "crypto";

/**
 * Extract trace ID from request headers or generate new one
 */
function extractTraceId(request: Request): string {
  return (
    request.headers.get("x-trace-id") ||
    request.headers.get("x-request-id") ||
    randomUUID()
  );
}

/**
 * Create response with trace ID included
 */
function createResponse(data: any, traceId: string, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ...data,
          traceId,
          timestamp: new Date().toISOString(),
        }),
      },
    ],
    isError,
  };
}

/**
 * Validate MCP request authentication
 */
async function validateRequest(request: Request): Promise<boolean> {
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.substring(7)
    : new URL(request.url).searchParams.get("token");
  const internalKey = new URL(request.url).searchParams.get("internal_key");

  if (token) {
    const payload = await SecurityProvider.verifyServiceToken(token);
    if (payload) return true;
  }

  if (internalKey && SecurityProvider.validateInternalKey(internalKey)) {
    return true;
  }

  return SecurityProvider.validateHeaders(request.headers);
}

/**
 * MCP Server Route Configuration
 */
export interface McpServerRoutes {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
}

/**
 * Factory function to create MCP server routes
 *
 * Creates standardized GET and POST handlers for SSE transport
 * with built-in authentication, trace ID injection, and error handling.
 *
 * @param server - The MCP server instance with registered tools
 * @param options - Optional configuration
 * @param options.enableLogging - Enable request logging (default: true)
 * @returns Object with GET and POST handlers
 *
 * @example
 * ```typescript
 * // In apps/your-app/src/app/api/mcp/route.ts
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { createMcpServerRoutes } from "@repo/mcp-protocol/server";
 *
 * const server = new McpServer({
 *   name: "your-app-server",
 *   version: "0.1.0",
 * });
 *
 * // Register tools...
 * server.tool("my_tool", "Description", schema, handler);
 *
 * export const { GET, POST } = createMcpServerRoutes(server);
 * ```
 */
export function createMcpServerRoutes(
  server: McpServer,
  options?: {
    enableLogging?: boolean;
  },
): McpServerRoutes {
  const enableLogging = options?.enableLogging ?? true;

  // Manage active transport (singleton per server instance)
  let transport: SSEServerTransport | null = null;

  return {
    /**
     * GET handler - Establishes SSE connection
     */
    GET: async (request: Request): Promise<Response> => {
      const traceId = extractTraceId(request);

      if (!(await validateRequest(request))) {
        return new Response("Unauthorized", { status: 401 });
      }

      if (enableLogging) {
        console.log(`[Trace:${traceId}] MCP SSE connection established`);
      }

      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      transport = new SSEServerTransport("/api/mcp", {
        write: (data: string) => writer.write(encoder.encode(data)),
        end: () => writer.close(),
      } as any);

      // Pass traceId to tool context
      (transport as any).traceId = traceId;

      await server.connect(transport);

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Trace-Id": traceId,
        },
      });
    },

    /**
     * POST handler - Processes MCP requests
     */
    POST: async (request: Request): Promise<Response> => {
      const traceId = extractTraceId(request);

      if (!(await validateRequest(request))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      if (!transport) {
        return Response.json(
          { error: "No active transport", traceId },
          { status: 400 },
        );
      }

      try {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            },
            { status: 400 },
          );
        }

        // Attach traceId to transport for tool execution context
        (transport as any).traceId = traceId;
        await (transport as any).handlePostRequest(request, Response as any);

        return new Response("OK", {
          headers: {
            "X-Trace-Id": traceId,
          },
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        return Response.json(
          {
            error: errorMessage,
            traceId,
          },
          {
            status: 500,
            headers: {
              "X-Trace-Id": traceId,
            },
          },
        );
      }
    },
  };
}

// Re-export utilities that may be useful
export { extractTraceId, validateRequest, createResponse };
