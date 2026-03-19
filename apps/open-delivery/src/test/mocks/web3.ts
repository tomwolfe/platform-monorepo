/**
 * Mock Web3 Providers for Testing
 * 
 * Provides mock implementations of viem/wagmi for unit and integration tests.
 * Use these to test Web3 functionality without connecting to real blockchains.
 * 
 * @example
 * import { mockPublicClient } from '@/test/mocks/web3';
 * 
 * // In your test
 * mockPublicClient.getTransactionReceipt.mockResolvedValue({...});
 */

import { vi } from "vitest";
import type { Hash, Address, TransactionReceipt, Transaction } from "viem";

// ============================================================================
// MOCK DATA
// ============================================================================

export const MOCK_ADDRESSES = {
  TREASURY: "0x1234567890123456789012345678901234567890" as Address,
  USER_1: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1" as Address,
  USER_2: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb2" as Address,
  USER_3: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb3" as Address,
  INVALID: "0xinvalid" as Address,
};

export const MOCK_TX_HASHES = {
  SUCCESS: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hash,
  FAILED: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hash,
  PENDING: "0xpending1234567890abcdef1234567890abcdef1234567890abcdef123456" as Hash,
  REVERTED: "0xreverted1234567890abcdef1234567890abcdef1234567890abcdef123456" as Hash,
};

export const MOCK_BLOCKS = {
  CURRENT: BigInt(10000),
  CONFIRMED: BigInt(9990),
};

// ============================================================================
// MOCK TRANSACTION RECEIPTS
// ============================================================================

export function createMockReceipt(overrides?: Partial<TransactionReceipt>): TransactionReceipt {
  return {
    blockHash: "0xblock1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hash,
    blockNumber: BigInt(9990),
    transactionHash: MOCK_TX_HASHES.SUCCESS,
    transactionIndex: 0,
    from: MOCK_ADDRESSES.USER_1,
    to: MOCK_ADDRESSES.TREASURY,
    status: "success",
    type: "0x2",
    cumulativeGasUsed: BigInt(100000),
    effectiveGasPrice: BigInt(1000000000),
    gasUsed: BigInt(21000),
    logs: [],
    logsBloom: "0x" + "00".repeat(256),
    ...overrides,
  } as TransactionReceipt;
}

// ============================================================================
// MOCK TRANSACTIONS
// ============================================================================

export function createMockTransaction(overrides?: Partial<Transaction>): Transaction {
  return {
    hash: MOCK_TX_HASHES.SUCCESS,
    from: MOCK_ADDRESSES.USER_1,
    to: MOCK_ADDRESSES.TREASURY,
    value: BigInt("10000000"), // 10 USDC
    gas: BigInt(21000),
    gasPrice: BigInt(1000000000),
    nonce: 1,
    input: "0x",
    blockHash: "0xblock1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hash,
    blockNumber: BigInt(9990),
    transactionIndex: 0,
    type: 2,
    chainId: 8453,
    ...overrides,
  } as Transaction;
}

// ============================================================================
// MOCK PUBLIC CLIENT
// ============================================================================

export const mockPublicClient = {
  getTransactionReceipt: vi.fn<
    (params: { hash: Hash }) => Promise<TransactionReceipt>
  >().mockResolvedValue(createMockReceipt()),

  getTransaction: vi.fn<
    (params: { hash: Hash }) => Promise<Transaction>
  >().mockResolvedValue(createMockTransaction()),

  getBlockNumber: vi.fn<
    () => Promise<bigint>
  >().mockResolvedValue(MOCK_BLOCKS.CURRENT),

  getBalance: vi.fn<
    (params: { address: Address }) => Promise<bigint>
  >().mockResolvedValue(BigInt("1000000000000000000")), // 1 ETH

  simulateContract: vi.fn().mockResolvedValue({ request: {} }),

  readContract: vi.fn().mockResolvedValue(BigInt("1000000")),

  waitForTransactionReceipt: vi.fn().mockResolvedValue(createMockReceipt()),
};

// ============================================================================
// MOCK SCENARIOS
// ============================================================================

export const scenarios = {
  /**
   * Successful payment scenario
   */
  successfulPayment: {
    setup: () => {
      mockPublicClient.getTransactionReceipt.mockResolvedValueOnce(
        createMockReceipt({ status: "success" })
      );
      mockPublicClient.getTransaction.mockResolvedValueOnce(
        createMockTransaction({ value: BigInt("10000000") })
      );
      mockPublicClient.getBlockNumber.mockResolvedValueOnce(MOCK_BLOCKS.CURRENT);
    },
    expected: {
      success: true,
      confirmations: 10,
    },
  },

  /**
   * Insufficient funds scenario
   */
  insufficientFunds: {
    setup: () => {
      mockPublicClient.getBalance.mockResolvedValueOnce(BigInt("0"));
    },
    expected: {
      success: false,
      error: "INSUFFICIENT_FUNDS",
    },
  },

  /**
   * Transaction reverted scenario
   */
  transactionReverted: {
    setup: () => {
      mockPublicClient.getTransactionReceipt.mockResolvedValueOnce(
        createMockReceipt({ status: "reverted" })
      );
    },
    expected: {
      success: false,
      error: "TX_FAILED",
    },
  },

  /**
   * RPC timeout scenario
   */
  rpcTimeout: {
    setup: () => {
      mockPublicClient.getTransactionReceipt.mockRejectedValueOnce(
        new Error("Request timeout")
      );
    },
    expected: {
      success: false,
      error: "RPC_TIMEOUT",
    },
  },

  /**
   * Insufficient confirmations scenario
   */
  insufficientConfirmations: {
    setup: () => {
      mockPublicClient.getTransactionReceipt.mockResolvedValueOnce(
        createMockReceipt({ blockNumber: MOCK_BLOCKS.CURRENT - BigInt(1) })
      );
      mockPublicClient.getTransaction.mockResolvedValueOnce(
        createMockTransaction({ value: BigInt("10000000") })
      );
      mockPublicClient.getBlockNumber.mockResolvedValueOnce(MOCK_BLOCKS.CURRENT);
    },
    expected: {
      success: false,
      error: "INSUFFICIENT_CONFIRMATIONS",
      confirmations: 1,
    },
  },

  /**
   * Wrong recipient scenario
   */
  wrongRecipient: {
    setup: () => {
      mockPublicClient.getTransactionReceipt.mockResolvedValueOnce(
        createMockReceipt({ to: MOCK_ADDRESSES.USER_2 })
      );
      mockPublicClient.getTransaction.mockResolvedValueOnce(
        createMockTransaction({ to: MOCK_ADDRESSES.USER_2 })
      );
    },
    expected: {
      success: false,
      error: "WRONG_RECIPIENT",
    },
  },

  /**
   * Wrong amount scenario
   */
  wrongAmount: {
    setup: () => {
      mockPublicClient.getTransactionReceipt.mockResolvedValueOnce(
        createMockReceipt({ status: "success" })
      );
      mockPublicClient.getTransaction.mockResolvedValueOnce(
        createMockTransaction({ value: BigInt("5000000") }) // Wrong amount
      );
    },
    expected: {
      success: false,
      error: "WRONG_AMOUNT",
    },
  },
};

// ============================================================================
// MOCK WAGMI HOOKS
// ============================================================================

export const mockWagmiHooks = {
  useAccount: vi.fn(() => ({
    address: MOCK_ADDRESSES.USER_1,
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
    data: createMockReceipt(),
    error: null,
  })),

  useBalance: vi.fn(() => ({
    data: {
      value: BigInt("1000000000000000000"),
      decimals: 18,
      symbol: "ETH",
      formatted: "1.0",
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
};

// ============================================================================
// TEST UTILITIES
// ============================================================================

/**
 * Reset all mocks to initial state
 */
export function resetMocks() {
  vi.clearAllMocks();
  mockPublicClient.getTransactionReceipt.mockResolvedValue(createMockReceipt());
  mockPublicClient.getTransaction.mockResolvedValue(createMockTransaction());
  mockPublicClient.getBlockNumber.mockResolvedValue(MOCK_BLOCKS.CURRENT);
}

/**
 * Setup mock for a specific scenario
 */
export function setupScenario(scenarioName: keyof typeof scenarios) {
  const scenario = scenarios[scenarioName];
  scenario.setup();
  return scenario.expected;
}

/**
 * Create a mock viem client
 */
export function createMockViemClient() {
  return {
    ...mockPublicClient,
    chain: { id: 8453, name: "Base" },
    transport: { value: {} },
  };
}

/**
 * Wait for mock to be called
 */
export async function waitForMockCall(mockFn: any, timeout = 5000) {
  const start = Date.now();
  while (mockFn.mock.calls.length === 0) {
    if (Date.now() - start > timeout) {
      throw new Error("Mock function was not called within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return mockFn.mock.calls[0];
}
