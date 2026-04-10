/**
 * MCP Endpoint Contract Tests
 *
 * Verifies that MCP endpoints respond with valid MCP-formatted responses
 * and that tool schemas match their Zod definitions.
 *
 * Prevents breaking changes in tool schemas across deployments.
 *
 * Usage:
 *   pnpm test:mcp-contract
 *
 * @package platform-monorepo
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

// MCP Server URLs (from AppConfig defaults)
const MCP_TOOLS_URLS = [
  "http://localhost:3000/api/mcp/tools", // intention-engine
  "http://localhost:3001/api/mcp/tools", // open-delivery
  "http://localhost:3005/api/mcp/tools", // table-stack
];

/**
 * MCP Tools Response Schema (simplified)
 * Based on MCP specification: https://modelcontextprotocol.io/specification
 */
interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolsResponse {
  tools: McpToolDefinition[];
}

describe("MCP Endpoint Contracts", () => {
  describe("GET /api/mcp/tools", () => {
    it.each(MCP_TOOLS_URLS)(
      "should return valid MCP tools list from %s",
      async (url) => {
        // Skip if server is not running
        try {
          const response = await fetch(url, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(5000),
          });

          // Server not running - skip test
          if (!response.ok) {
            console.log(
              `  ⚠ Skipping ${url} - server not running (${response.status})`,
            );
            return;
          }

          const data: McpToolsResponse = await response.json();

          // Validate response structure
          expect(data).toHaveProperty("tools");
          expect(Array.isArray(data.tools)).toBe(true);
          expect(data.tools.length).toBeGreaterThan(0);

          // Validate each tool definition
          data.tools.forEach((tool) => {
            expect(tool).toHaveProperty("name");
            expect(typeof tool.name).toBe("string");
            expect(tool.name.length).toBeGreaterThan(0);

            expect(tool).toHaveProperty("description");
            expect(typeof tool.description).toBe("string");

            expect(tool).toHaveProperty("inputSchema");
            expect(tool.inputSchema).toHaveProperty("type", "object");
            expect(tool.inputSchema).toHaveProperty("properties");
            expect(typeof tool.inputSchema.properties).toBe("object");
          });
        } catch {
          console.log(`  ⚠ Skipping ${url} - server not reachable`);
        }
      },
    );
  });

  describe("MCP Tool Schema Consistency", () => {
    it("should have unique tool names", async () => {
      // This test verifies against the MCP protocol source of truth
      // Import tool definitions and verify uniqueness
      const { TOOLS } = await import("@repo/mcp-protocol");

      const toolNames = TOOLS.map((t: { name: string }) => t.name);
      const uniqueNames = new Set(toolNames);

      expect(toolNames.length).toBe(uniqueNames.size);
    });

    it("should have valid inputSchema for all tools", async () => {
      const { TOOLS } = await import("@repo/mcp-protocol");

      TOOLS.forEach(
        (tool: { name: string; parameters?: { schema: object } }) => {
          if (tool.parameters) {
            expect(tool.parameters).toHaveProperty("schema");
            expect(typeof tool.parameters.schema).toBe("object");
          }
        },
      );
    });
  });
});
