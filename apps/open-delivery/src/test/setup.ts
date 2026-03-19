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
  };
});

// Mock wagmi globally
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

// Mock Web3Provider context
vi.mock("@/components/Web3Provider", () => ({
  useWeb3: vi.fn(() => ({
    treasuryAddress: "0x1234567890123456789012345678901234567890",
    defaultChainId: 8453,
    supportedChainIds: [8453, 137, 1],
  })),
  Web3Provider: vi.fn(({ children }) => children),
}));

// Reset mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

// Global test timeout
vi.setConfig({
  testTimeout: 10000,
});
