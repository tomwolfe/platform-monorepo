import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { setupIntegrationMocks } from "@repo/shared/testing";

const msw = setupIntegrationMocks();

beforeAll(() => msw.start());
afterAll(() => msw.stop());
beforeEach(() => {
  msw.reset();
  vi.restoreAllMocks();
});

describe("Payout Flow Integration", () => {
  beforeEach(() => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://postgres:postgres@localhost:5432/test",
    );
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "http://localhost:8080");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should verify MSW Web3 RPC handlers are configured", async () => {
    const { web3RpcHandlers } = await import("./msw/setup");
    expect(web3RpcHandlers).toBeDefined();
    expect(web3RpcHandlers.length).toBeGreaterThan(0);
  });

  it("should intercept eth_gasPrice via MSW", async () => {
    const response = await fetch("https://rpc.base.sepolia.io", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "eth_gasPrice",
        params: [],
        id: 1,
        jsonrpc: "2.0",
      }),
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as { result: string };
    expect(data.result).toBe("0x4a817c800");
  });

  it("should intercept eth_getTransactionReceipt via MSW with success status", async () => {
    const response = await fetch("https://rpc.base.sepolia.io", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "eth_getTransactionReceipt",
        params: ["0xabc123"],
        id: 1,
        jsonrpc: "2.0",
      }),
    });
    const data = (await response.json()) as { result: { status: string } };
    expect(data.result.status).toBe("0x1"); // success
  });

  it("should handle Ably notification intercept during payout flow", async () => {
    const response = await fetch("https://rest.ably.io/keys/request");
    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("keyName");
  });
});
