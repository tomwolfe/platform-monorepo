/**
 * MSW Integration Test Handlers
 *
 * Centralized mock handlers for external services used across all apps.
 * Eliminates duplication between apps/table-stack and apps/open-delivery.
 *
 * Services mocked:
 * - Web3 RPC (Base chain)
 * - Ably (Pub/Sub messaging)
 * - Resend (Email API)
 * - Price Oracle (Crypto prices)
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

// ============================================================================
// WEB3 RPC HANDLERS
// ============================================================================

export const web3RpcHandlers = [
  http.post("*", async ({ request }) => {
    // Skip non-RPC requests (like Resend, Ably, internal APIs)
    const url = new URL(request.url);
    if (
      url.hostname.includes("resend") ||
      url.hostname.includes("ably") ||
      url.pathname.startsWith("/api/")
    ) {
      return; // Let other handlers process it
    }

    let body: { method: string; params?: unknown[] };
    try {
      body = (await request.json()) as { method: string; params?: unknown[] };
    } catch {
      return HttpResponse.json({ error: "Invalid JSON-RPC" }, { status: 400 });
    }

    switch (body.method) {
      case "eth_getTransactionReceipt":
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            status: "0x1",
            transactionHash: (body.params?.[0] as string) || "0xmock",
            blockNumber: "0x123456",
            gasUsed: "0x5208",
          },
        });
      case "eth_gasPrice":
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: 1,
          result: "0x4a817c800", // 20 Gwei
        });
      case "eth_estimateGas":
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: 1,
          result: "0x5208",
        });
      case "eth_call":
        return HttpResponse.json({ jsonrpc: "2.0", id: 1, result: "0x" });
      case "eth_chainId":
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: 1,
          result: "0x2105", // Base (8453)
        });
      case "eth_blockNumber":
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: 1,
          result: "0x123456",
        });
      case "net_version":
        return HttpResponse.json({ jsonrpc: "2.0", id: 1, result: "8453" });
      default:
        return HttpResponse.json({ jsonrpc: "2.0", id: 1, result: null });
    }
  }),
];

// ============================================================================
// ABLY HANDLERS
// ============================================================================

export const ablyHandlers = [
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
];

// ============================================================================
// RESEND HANDLERS
// ============================================================================

export const resendHandlers = [
  http.post("https://api.resend.com/emails", async () => {
    return HttpResponse.json({ id: "email_test_12345" });
  }),
];

// ============================================================================
// PRICE ORACLE HANDLERS
// ============================================================================

export const priceOracleHandlers = [
  http.get("*/api/prices", async () => {
    return HttpResponse.json({
      ETH: { USD: 3500.0 },
      BASE: { USD: 3500.0 },
    });
  }),
];

// ============================================================================
// SERVER SETUP
// ============================================================================

export interface MockServerInstance {
  server: ReturnType<typeof setupServer>;
  start: () => void;
  stop: () => void;
  reset: () => void;
}

/**
 * Create and configure the MSW integration mock server.
 * Includes all external service handlers (Web3, Ably, Resend, Price Oracle).
 *
 * @example
 * ```ts
 * const mocks = setupIntegrationMocks();
 * beforeAll(() => mocks.start());
 * afterAll(() => mocks.stop());
 * afterEach(() => mocks.reset());
 * ```
 */
export function setupIntegrationMocks(): MockServerInstance {
  const server = setupServer(
    ...web3RpcHandlers,
    ...ablyHandlers,
    ...resendHandlers,
    ...priceOracleHandlers,
  );

  return {
    server,
    start: () => server.listen({ onUnhandledRequest: "bypass" }),
    stop: () => server.close(),
    reset: () => server.resetHandlers(),
  };
}
