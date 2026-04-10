import { NextRequest, NextResponse } from "next/server";
import { withUnifiedApiHandler } from "@repo/shared";
import { forceRefreshMcpCache } from "@/lib/engine/mcp-discovery";

/**
 * POST /api/mcp/refresh
 *
 * Forces an immediate refresh of the MCP tool discovery cache.
 * Useful after deploying a new satellite app or updating tool schemas.
 *
 * Trigger this endpoint from deployment pipelines to ensure
 * the Intention Engine immediately discovers new tools.
 */
async function mcpRefreshHandler(_req: NextRequest) {
  const result = await forceRefreshMcpCache();

  return NextResponse.json({
    success: true,
    message: `MCP cache refreshed: ${result.discoveredTools.length} tools discovered`,
    toolCount: result.allTools.length,
    discoveredTools: result.discoveredTools.map((t) => t.name),
    fromCache: false,
    discoveryLatencyMs: result.discoveryLatencyMs,
  });
}

export const POST = withUnifiedApiHandler(mcpRefreshHandler, {
  serviceName: "mcp-refresh",
});
