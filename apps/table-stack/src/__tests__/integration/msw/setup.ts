import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

// Web3 RPC handlers (for Base chain - chainId 8453)
export const web3RpcHandlers = [
  http.post("*", async ({ request }) => {
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

// Ably handlers
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

// Resend email API handlers
export const resendHandlers = [
  http.post("https://api.resend.com/emails", async () => {
    return HttpResponse.json({ id: "email_test_12345" });
  }),
];

// Price oracle handlers
export const priceOracleHandlers = [
  http.get("*/api/prices", async () => {
    return HttpResponse.json({
      ETH: { USD: 3500.0 },
      BASE: { USD: 3500.0 },
    });
  }),
];

export function setupIntegrationMocks() {
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
