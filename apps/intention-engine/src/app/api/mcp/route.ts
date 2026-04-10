import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { McpManager } from "@/infrastructure/McpManager";
import { listTools } from "@/lib/tools/registry";
import { withUnifiedApiHandler, formatApiSuccess } from "@repo/shared";

// Instantiate McpManager with all registered tools
const mcpManager = new McpManager(listTools());

// ============================================================================
// REQUEST SCHEMAS
// ============================================================================

/**
 * MCP tools/call request parameters schema
 */
const ToolsCallParamsSchema = z.object({
  name: z.string().describe("Tool name to call"),
  arguments: z.record(z.unknown()).optional().describe("Tool arguments"),
});

/**
 * MCP request body schema
 */
const McpRequestBodySchema = z.object({
  method: z.string().describe("MCP method name"),
  params: z.unknown().optional().describe("Method parameters"),
  id: z.union([z.string(), z.number()]).describe("Request ID"),
});

// ============================================================================
// API HANDLER
// ============================================================================

async function mcpHandler(req: NextRequest) {
  const body = await req.json();

  // Validate request body structure
  const validatedBody = McpRequestBodySchema.safeParse(body);
  if (!validatedBody.success) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: body?.id ?? null,
        error: {
          code: -32700,
          message: "Parse error",
          data: validatedBody.error.message,
        },
      },
      { status: 400 },
    );
  }

  const { method, params, id } = validatedBody.data;

  if (method === "notifications/initialized") {
    return new NextResponse(null, { status: 204 });
  }

  if (method === "tools/list") {
    const result = await mcpManager.listTools();
    return NextResponse.json({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  if (method === "tools/call") {
    // Validate tools/call parameters with Zod schema
    const validatedParams = ToolsCallParamsSchema.safeParse(params);
    if (!validatedParams.success) {
      return NextResponse.json(
        {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: "Invalid params",
            data: validatedParams.error.message,
          },
        },
        { status: 400 },
      );
    }

    const { name, arguments: rawArgs } = validatedParams.data;

    // DISTRIBUTED TRACING: Extract trace context from incoming request
    // and propagate it to the tool execution for end-to-end tracing
    const traceId = req.headers.get("x-trace-id");
    const correlationId = req.headers.get("x-correlation-id");

    // Enrich tool arguments with tracing context
    const args = rawArgs
      ? {
          ...rawArgs,
          _tracingContext: {
            traceId: traceId || undefined,
            correlationId: correlationId || undefined,
          },
        }
      : {
          _tracingContext: {
            traceId: traceId || undefined,
            correlationId: correlationId || undefined,
          },
        };

    try {
      const result = await mcpManager.callTool(name, args);
      return NextResponse.json({
        jsonrpc: "2.0",
        id,
        result,
      });
    } catch (toolError) {
      console.error(`[MCP] Tool execution error for '${name}':`, toolError);
      return NextResponse.json(
        {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: `Tool execution failed: ${toolError instanceof Error ? toolError.message : String(toolError)}`,
          },
        },
        { status: 500 },
      );
    }
  }

  return NextResponse.json(
    {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: "Method not found",
      },
    },
    { status: 404 },
  );
}

export const POST = withUnifiedApiHandler(mcpHandler, { serviceName: "mcp" });
