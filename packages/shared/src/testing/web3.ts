/**
 * Web3 Testing Utilities
 *
 * Consolidated Web3 mock infrastructure for consistent testing across the monorepo.
 * Provides Anvil helper, viem mock factories, and MSW RPC handlers.
 *
 * Usage:
 * ```typescript
 * // In vitest.config.ts or test setup
 * import { setupViemMocks, createMockPublicClient } from '@repo/shared/testing/web3';
 *
 * // Before tests
 * setupViemMocks(vi);
 *
 * // In tests
 * const mockClient = createMockPublicClient({
 *   getTransactionReceipt: { /* mock data *\/ },
 * });
 * ```
 *
 * @see Task T5: Consolidate Web3 Mocks
 */

import type { Mock } from "vitest";

// ============================================================================
// VIEM MOCK FACTORY
// ============================================================================

/**
 * Setup global viem mocks for Vitest
 *
 * Call this in your test setup file to mock all viem functions
 *
 * @param vi - Vitest instance (passed from test file)
 *
 * @example
 * ```typescript
 * import { vi } from 'vitest';
 * import { setupViemMocks } from '@repo/shared/testing/web3';
 *
 * setupViemMocks(vi);
 * ```
 */
export function setupViemMocks(vi: (typeof import("vitest"))["vi"]) {
  vi.mock("viem", async () => {
    const actual = await vi.importActual("viem");
    return {
      ...(actual as object),
      createPublicClient: vi.fn(() => createMockPublicClient()),
      http: vi.fn(),
      formatUnits: vi.fn((value: bigint | string, decimals: number) => {
        return String(BigInt(value) / BigInt(Math.pow(10, decimals)));
      }),
      parseUnits: vi.fn((value: string, decimals: number) => {
        return BigInt(parseFloat(value) * Math.pow(10, decimals));
      }),
      isAddress: vi.fn((address: string) => {
        return /^0x[a-fA-F0-9]{40}$/.test(address);
      }),
      isHash: vi.fn((hash: string) => {
        return /^0x[a-fA-F0-9]{64}$/.test(hash);
      }),
      stringToHex: vi.fn((str: string) => {
        return `0x${Buffer.from(str, "utf-8").toString("hex")}`;
      }),
    };
  });
}

/**
 * Mock public client factory
 *
 * Creates a mock viem public client with configurable method implementations
 *
 * @param overrides - Custom implementations for client methods
 * @returns Mock public client object
 *
 * @example
 * ```typescript
 * const client = createMockPublicClient({
 *   getTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
 *   getTransaction: vi.fn().mockResolvedValue({ input: '0x' }),
 * });
 * ```
 */
export function createMockPublicClient(
  overrides: Record<string, Mock | unknown> = {},
) {
  return {
    getTransactionReceipt: vi.fn().mockResolvedValue({
      status: "success",
      confirmations: 1,
      blockNumber: BigInt(12345678),
      ...overrides.getTransactionReceipt,
    }),
    getTransaction: vi.fn().mockResolvedValue({
      input: "0x",
      hash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      to: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1",
      value: BigInt("1000000000000000000"),
      ...overrides.getTransaction,
    }),
    getBlockNumber: vi.fn().mockResolvedValue(BigInt(12345678)),
    getBalance: vi.fn().mockResolvedValue(BigInt("1000000000000000000")),
    ...overrides,
  };
}

// ============================================================================
// WAGMI MOCK FACTORY
// ============================================================================

/**
 * Setup global wagmi mocks for Vitest
 *
 * Call this in your test setup file to mock all wagmi hooks
 *
 * @param vi - Vitest instance (passed from test file)
 *
 * @example
 * ```typescript
 * import { vi } from 'vitest';
 * import { setupWagmiMocks } from '@repo/shared/testing/web3';
 *
 * setupWagmiMocks(vi);
 * ```
 */
export function setupWagmiMocks(vi: (typeof import("vitest"))["vi"]) {
  vi.mock("wagmi", async () => {
    const actual = await vi.importActual("wagmi");
    return {
      ...(actual as object),
      useAccount: vi.fn(() => ({
        address: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1",
        isConnected: true,
        chain: { id: 8453, name: "Base" },
      })),
      useSendTransaction: vi.fn(() => ({
        data: null,
        sendTransaction: vi.fn(),
        error: null,
        status: "idle",
        reset: vi.fn(),
      })),
      useWaitForTransactionReceipt: vi.fn(() => ({
        isLoading: false,
        isSuccess: true,
        data: null,
        error: null,
      })),
      useBalance: vi.fn(() => ({
        data: {
          value: BigInt("1000000000000000000"),
          decimals: 18,
          symbol: "ETH",
        },
        isLoading: false,
        error: null,
      })),
      useConnect: vi.fn(() => ({
        connect: vi.fn(),
        connectors: [
          { id: "coinbase", name: "Coinbase Wallet" },
          { id: "metaMask", name: "MetaMask" },
        ],
        status: "idle",
        error: null,
      })),
      useDisconnect: vi.fn(() => ({
        disconnect: vi.fn(),
      })),
      useSignMessage: vi.fn(() => ({
        signMessage: vi.fn(),
        data: null,
        error: null,
        isPending: false,
      })),
      useWriteContract: vi.fn(() => ({
        writeContract: vi.fn(),
        data: null,
        error: null,
        isPending: false,
      })),
      useReadContract: vi.fn(() => ({
        data: null,
        error: null,
        isLoading: false,
        refetch: vi.fn(),
      })),
      createConfig: vi.fn(),
      createStorage: vi.fn(),
      fallback: vi.fn(),
      http: vi.fn(),
    };
  });

  vi.mock("wagmi/chains", async () => {
    const actual = await vi.importActual("wagmi/chains");
    return {
      ...(actual as object),
      base: {
        id: 8453,
        name: "Base",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: ["https://mainnet.base.org"] } },
        blockExplorers: {
          default: { name: "Basescan", url: "https://basescan.org" },
        },
      },
      polygon: {
        id: 137,
        name: "Polygon",
        nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
        rpcUrls: { default: { http: ["https://polygon-rpc.com"] } },
      },
      mainnet: {
        id: 1,
        name: "Ethereum",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: {
          default: { http: ["https://eth-mainnet.g.alchemy.com/v2/demo"] },
        },
      },
    };
  });
}

// ============================================================================
// ERC20 ABI MOCK
// ============================================================================

/**
 * Setup ERC20 ABI mock
 *
 * @param vi - Vitest instance (passed from test file)
 */
export function setupERC20Mock(vi: (typeof import("vitest"))["vi"]) {
  vi.mock("@repo/shared/utils/erc20-abi", () => ({
    ERC20_ABI: [
      {
        inputs: [{ name: "account", type: "address" }],
        name: "balanceOf",
        outputs: [{ type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
      {
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        name: "transfer",
        outputs: [{ type: "bool" }],
        stateMutability: "nonpayable",
        type: "function",
      },
    ],
  }));
}

// ============================================================================
// ANVIL TEST HELPERS
// ============================================================================

/**
 * Anvil configuration helper
 *
 * Returns the Anvil RPC URL for integration tests
 *
 * @param port - Anvil port (default: 8545)
 * @returns Anvil RPC URL
 *
 * @example
 * ```typescript
 * const anvilUrl = getAnvilRpcUrl();
 * // Use with viem client for real blockchain testing
 * ```
 */
export function getAnvilRpcUrl(port: number = 8545): string {
  return `http://localhost:${port}`;
}

/**
 * Check if Anvil is running
 *
 * @param port - Anvil port (default: 8545)
 * @returns true if Anvil is reachable
 */
export async function isAnvilRunning(port: number = 8545): Promise<boolean> {
  try {
    const response = await fetch(getAnvilRpcUrl(port), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_blockNumber",
        params: [],
        id: 1,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Skip test if Anvil is not running
 *
 * Use this to gracefully skip Anvil-dependent tests when Anvil is not available
 *
 * @param port - Anvil port (default: 8545)
 */
export async function skipIfAnvilNotRunning(
  port: number = 8545,
): Promise<void> {
  const { skip } = await import("vitest");
  if (!(await isAnvilRunning(port))) {
    skip();
  }
}

// ============================================================================
// MSW WEB3 RPC HANDLERS
// ============================================================================

/**
 * Create MSW handlers for Web3 RPC calls
 *
 * Use this to mock RPC calls in integration tests without needing Anvil
 *
 * @param overrides - Custom handler implementations
 * @returns Array of MSW handlers
 *
 * @example
 * ```typescript
 * import { http, HttpResponse } from 'msw';
 * import { setupServer } from 'msw/node';
 * import { createWeb3RpcHandlers } from '@repo/shared/testing/web3';
 *
 * const server = setupServer(...createWeb3RpcHandlers());
 *
 * beforeAll(() => server.listen());
 * afterEach(() => server.resetHandlers());
 * afterAll(() => server.close());
 * ```
 */
export function createWeb3RpcHandlers(
  _overrides: Record<string, unknown> = {},
): unknown[] {
  // Note: This requires 'msw' to be installed
  // We return an empty array if msw is not available
  try {
    const { http, HttpResponse } = require("msw");

    return [
      http.post("*/", async ({ request }) => {
        const body = (await request.json()) as { method: string };

        // Handle common RPC methods
        switch (body.method) {
          case "eth_blockNumber":
            return HttpResponse.json({
              jsonrpc: "2.0",
              id: 1,
              result: "0xbc614e", // 12345678 in hex
            });
          case "eth_getTransactionReceipt":
            return HttpResponse.json({
              jsonrpc: "2.0",
              id: 1,
              result: {
                status: "0x1", // success
                confirmations: "0x1",
                blockNumber: "0xbc614e",
              },
            });
          case "eth_getTransactionByHash":
            return HttpResponse.json({
              jsonrpc: "2.0",
              id: 1,
              result: {
                input: "0x",
                hash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                to: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1",
                value: "0xde0b6b3a7640000", // 1 ETH
              },
            });
          case "eth_getBalance":
            return HttpResponse.json({
              jsonrpc: "2.0",
              id: 1,
              result: "0xde0b6b3a7640000", // 1 ETH
            });
          default:
            return HttpResponse.json({
              jsonrpc: "2.0",
              id: 1,
              result: null,
            });
        }
      }),
    ];
  } catch {
    console.warn("[Web3 Testing] MSW not available, returning empty handlers");
    return [];
  }
}
