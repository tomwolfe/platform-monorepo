import { describe, it, expect, vi, beforeEach } from "vitest";
import { MCPClient } from "../../infrastructure/mcp/MCPClient";

describe("MCP Retry Logic", () => {
  it("should retry on failure and succeed after multiple attempts", async () => {
    // Use a dummy URL, we will mock the internal client
    const client = new MCPClient("http://localhost:8080");

    let attempts = 0;
    // Mock callTool to fail twice and succeed on third attempt
    (client as any).client = {
      callTool: async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("429 Too Many Requests");
        }
        return { content: [{ type: "text", text: "Success" }] };
      },
      connect: async () => {},
      close: async () => {},
    };

    const result = await client.callTool("test_tool", {});

    expect(attempts).toBe(3);
    expect(result.content[0].text).toBe("Success");
  });

  it("should fail after max retries", async () => {
    const client = new MCPClient("http://localhost:8080");
    const maxRetries = 3;

    let attempts = 0;
    (client as any).client = {
      callTool: async () => {
        attempts++;
        throw new Error("500 Internal Server Error");
      },
      connect: async () => {},
      close: async () => {},
    };

    await expect(client.callTool("test_tool", {})).rejects.toThrow();
    // Should attempt initial call + retries
    expect(attempts).toBeGreaterThan(1);
  });
});
