/**
 * MSW Handler Contract Tests
 *
 * Validates that mock handlers return responses matching the real API shape.
 * This prevents drift between mocks and real services.
 *
 * @see T6: Enhance Integration Test Reliability
 */

import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

// ============================================================================
// CONTRACT: Web3 RPC Responses
// ============================================================================

describe("Web3 RPC Contract", () => {
  const server = setupServer(
    http.post("https://base-mainnet.example/*", async ({ request }) => {
      const body = (await request.json()) as { method: string };
      if (body.method === "eth_getTransactionReceipt") {
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            status: "0x1",
            transactionHash: "0xmock",
            blockNumber: "0x123456",
            gasUsed: "0x5208",
          },
        });
      }
      return HttpResponse.json({ jsonrpc: "2.0", id: 1, result: null });
    }),
  );

  beforeAll(() => server.listen());
  afterAll(() => server.close());
  afterEach(() => server.resetHandlers());

  it("should return valid JSON-RPC response for eth_getTransactionReceipt", async () => {
    const response = await fetch("https://base-mainnet.example/rpc", {
      method: "POST",
      body: JSON.stringify({
        method: "eth_getTransactionReceipt",
        params: ["0x123"],
        id: 1,
        jsonrpc: "2.0",
      }),
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<string, unknown>;

    // Contract: JSON-RPC shape
    expect(data).toHaveProperty("jsonrpc", "2.0");
    expect(data).toHaveProperty("id");
    expect(data).toHaveProperty("result");

    const result = data.result as Record<string, unknown>;
    expect(result).toHaveProperty("status", "0x1");
    expect(result).toHaveProperty("transactionHash");
    expect(result).toHaveProperty("blockNumber");
    expect(result).toHaveProperty("gasUsed");
  });

  it("should return null result for unknown methods", async () => {
    const response = await fetch("https://base-mainnet.example/rpc", {
      method: "POST",
      body: JSON.stringify({
        method: "eth_unknownMethod",
        params: [],
        id: 1,
        jsonrpc: "2.0",
      }),
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data.result).toBeNull();
  });
});

// ============================================================================
// CONTRACT: Ably API Responses
// ============================================================================

describe("Ably Contract", () => {
  const server = setupServer(
    http.post("https://rest.ably.io/*", async () => {
      return HttpResponse.json({
        messageIds: ["msg:0:0:0:abc123"],
        errorCode: null,
        errorMessage: null,
      });
    }),
    http.get("https://rest.ably.io/keys/request", async () => {
      return HttpResponse.json({
        keyName: "test.key",
        capability: "{}",
        expires: Date.now() + 3600000,
      });
    }),
  );

  beforeAll(() => server.listen());
  afterAll(() => server.close());

  it("should return valid publish response", async () => {
    const response = await fetch(
      "https://rest.ably.io/channels/test/messages",
      {
        method: "POST",
        body: JSON.stringify({ name: "event", data: {} }),
      },
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("messageIds");
    expect(Array.isArray(data.messageIds)).toBe(true);
    expect(data.errorCode).toBeNull();
    expect(data.errorMessage).toBeNull();
  });

  it("should return valid token request response", async () => {
    const response = await fetch("https://rest.ably.io/keys/request");

    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("keyName");
    expect(data).toHaveProperty("capability");
    expect(data).toHaveProperty("expires");
    expect(typeof (data.expires as number)).toBe("number");
  });
});

// ============================================================================
// CONTRACT: Resend API Responses
// ============================================================================

describe("Resend Contract", () => {
  const server = setupServer(
    http.post("https://api.resend.com/emails", async () => {
      return HttpResponse.json({ id: "email_test_12345" });
    }),
  );

  beforeAll(() => server.listen());
  afterAll(() => server.close());

  it("should return valid email send response", async () => {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "test@example.com",
        to: "recipient@example.com",
        subject: "Test",
        html: "<p>Hello</p>",
      }),
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("id");
    expect(typeof data.id).toBe("string");
  });
});

// ============================================================================
// CONTRACT: Price Oracle Responses
// ============================================================================

describe("Price Oracle Contract", () => {
  const server = setupServer(
    http.get("*/api/prices", async () => {
      return HttpResponse.json({
        ETH: { USD: 3500.0 },
        BASE: { USD: 3500.0 },
      });
    }),
  );

  beforeAll(() => server.listen());
  afterAll(() => server.close());

  it("should return valid price response with required currencies", async () => {
    const response = await fetch("https://oracle.example.com/api/prices");

    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<
      string,
      Record<string, number>
    >;

    // Contract: Must include at least ETH pricing
    expect(data).toHaveProperty("ETH");
    expect(data.ETH).toHaveProperty("USD");
    expect(typeof data.ETH.USD).toBe("number");
    expect(data.ETH.USD).toBeGreaterThan(0);
  });
});

// ============================================================================
// CONTRACT: MSW Shared Handlers Match Individual Service Contracts
// ============================================================================

import {
  web3RpcHandlers,
  ablyHandlers,
  resendHandlers,
  priceOracleHandlers,
} from "../testing/msw/handlers";

describe("Shared MSW Handlers - Web3 RPC Contract", () => {
  const server = setupServer(...web3RpcHandlers);

  beforeAll(() => server.listen());
  afterAll(() => server.close());

  it("should handle eth_gasPrice with valid JSON-RPC shape", async () => {
    const response = await fetch("https://base-rpc.example", {
      method: "POST",
      body: JSON.stringify({
        method: "eth_gasPrice",
        params: [],
        id: 1,
        jsonrpc: "2.0",
      }),
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data.jsonrpc).toBe("2.0");
    expect(data.result).toBeDefined();
    // Gas price should be a hex string
    expect(typeof data.result).toBe("string");
    expect((data.result as string).startsWith("0x")).toBe(true);
  });

  it("should handle eth_chainId with correct chain", async () => {
    const response = await fetch("https://base-rpc.example", {
      method: "POST",
      body: JSON.stringify({
        method: "eth_chainId",
        params: [],
        id: 1,
        jsonrpc: "2.0",
      }),
    });

    const data = (await response.json()) as Record<string, unknown>;
    // 0x2105 = 8453 (Base mainnet)
    expect(data.result).toBe("0x2105");
  });

  it("should bypass non-RPC requests (resend, ably, api paths)", async () => {
    // The handler should return undefined for non-RPC requests
    // MSW will pass through to the next handler
    const response = await fetch("https://api.resend.com/test", {
      method: "POST",
    });

    // Should not be handled by web3RpcHandlers (returns no response)
    expect(response.status).not.toBe(200);
  });
});

describe("Shared MSW Handlers - Ably Contract", () => {
  const server = setupServer(...ablyHandlers);

  beforeAll(() => server.listen());
  afterAll(() => server.close());

  it("should handle publish requests", async () => {
    const response = await fetch(
      "https://rest.ably.io/channels/test/messages",
      {
        method: "POST",
        body: JSON.stringify({ name: "event", data: {} }),
      },
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data.messageIds).toBeDefined();
    expect(Array.isArray(data.messageIds)).toBe(true);
  });

  it("should handle token request", async () => {
    const response = await fetch("https://rest.ably.io/keys/request");

    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data.keyName).toBeDefined();
    expect(data.expires).toBeDefined();
  });
});

describe("Shared MSW Handlers - Resend Contract", () => {
  const server = setupServer(...resendHandlers);

  beforeAll(() => server.listen());
  afterAll(() => server.close());

  it("should handle email send requests", async () => {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data.id).toBeDefined();
  });
});

describe("Shared MSW Handlers - Price Oracle Contract", () => {
  const server = setupServer(...priceOracleHandlers);

  beforeAll(() => server.listen());
  afterAll(() => server.close());

  it("should return ETH pricing in USD", async () => {
    const response = await fetch("https://oracle.example.com/api/prices");

    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<
      string,
      Record<string, number>
    >;
    expect(data.ETH.USD).toBeGreaterThan(0);
  });
});
