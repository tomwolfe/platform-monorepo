/**
 * Vitest Test Setup
 *
 * Global test configuration and mocks for Web3 testing
 */

import { vi, beforeEach } from "vitest";

// Mock viem globally
vi.mock("viem", async () => {
  const actual = await vi.importActual("viem");
  return {
    ...(actual as any),
    createPublicClient: vi.fn(() => ({
      getTransactionReceipt: vi.fn(),
      getTransaction: vi.fn(),
      getBlockNumber: vi.fn(),
      getBalance: vi.fn(),
    })),
    http: vi.fn(),
    formatUnits: vi.fn((value, decimals) => {
      return String(BigInt(value) / BigInt(Math.pow(10, decimals)));
    }),
    parseUnits: vi.fn((value, decimals) => {
      return BigInt(parseFloat(value) * Math.pow(10, decimals));
    }),
    isAddress: vi.fn((address) => {
      return /^0x[a-fA-F0-9]{40}$/.test(address);
    }),
    isHash: vi.fn((hash) => {
      return /^0x[a-fA-F0-9]{64}$/.test(hash);
    }),
    stringToHex: vi.fn((str) => {
      return `0x${Buffer.from(str, 'utf-8').toString('hex')}`;
    }),
  };
});

// Mock wagmi globally - ENHANCED for CryptoCheckout tests
vi.mock("wagmi", async () => {
  const actual = await vi.importActual("wagmi");
  return {
    ...(actual as any),
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
    // CRITICAL: Mock useSignMessage for signature flow
    useSignMessage: vi.fn(() => ({
      signMessage: vi.fn(),
      data: null,
      error: null,
      isPending: false,
    })),
    // Mock useWriteContract for USDC transfers
    useWriteContract: vi.fn(() => ({
      writeContract: vi.fn(),
      data: null,
      error: null,
      isPending: false,
    })),
    // Mock useReadContract for balance checks
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

// Mock wagmi/chains
vi.mock("wagmi/chains", async () => {
  const actual = await vi.importActual("wagmi/chains");
  return {
    ...(actual as any),
    base: {
      id: 8453,
      name: "Base",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: ["https://mainnet.base.org"] } },
      blockExplorers: { default: { name: "Basescan", url: "https://basescan.org" } },
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
      rpcUrls: { default: { http: ["https://eth-mainnet.g.alchemy.com/v2/demo"] } },
    },
  };
});

// Mock @repo/shared/utils/erc20-abi
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

// Reset mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

// Global test timeout
vi.setConfig({
  testTimeout: 10000,
});
