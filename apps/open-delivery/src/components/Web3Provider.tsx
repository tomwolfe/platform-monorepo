"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http } from "wagmi";
import { base, polygon, mainnet } from "wagmi/chains";
import { coinbaseWallet, metaMask } from "wagmi/connectors";
import { createContext, useContext, useState, type ReactNode } from "react";
import { createStorage, fallback } from "wagmi";

// ============================================================================
// CONFIGURATION
// Default to Base for low fees and fast transactions
// ============================================================================

const TREASURY_ADDRESS = process.env.NEXT_PUBLIC_TREASURY_WALLET_ADDRESS || "0x0000000000000000000000000000000000000000";
const USDC_CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS;

// Supported chains for delivery payments
const chains = [base, polygon, mainnet] as const;
const defaultChain = base; // Base is default for low fees

// Create persistent storage for wagmi (optional, for session persistence)
const storage = createStorage({
  storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  key: 'wagmi.store',
});

// Create wagmi config with client auto-detection
const config = createConfig({
  chains: [defaultChain, ...chains],
  ssr: true, // Enable SSR compatibility for Next.js
  storage,
  transports: {
    [base.id]: fallback([http(), http("https://mainnet.base.org")]),
    [polygon.id]: fallback([http(), http("https://polygon-rpc.com")]),
    [mainnet.id]: fallback([http(), http("https://eth.llamarpc.com")]),
  },
  connectors: [
    coinbaseWallet({
      appName: "OpenDeliver",
      appLogoUrl: "🚚",
    }),
    metaMask(),
  ],
});

// ============================================================================
// QUERY CLIENT
// Singleton pattern to avoid creating multiple instances
// ============================================================================

let queryClientSingleton: QueryClient | undefined;

function getQueryClient() {
  if (typeof window === "undefined") {
    // Server: always create a new query client
    return new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 60 * 1000, // 1 minute
          retry: 2,
          refetchOnWindowFocus: false,
        },
      },
    });
  }

  // Browser: use singleton
  if (!queryClientSingleton) {
    queryClientSingleton = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 60 * 1000, // 1 minute
          retry: 2,
          refetchOnWindowFocus: false,
        },
      },
    });
  }
  return queryClientSingleton;
}

// ============================================================================
// WEB3 CONTEXT
// For accessing Web3 state throughout the app
// ============================================================================

interface Web3ContextType {
  treasuryAddress: string;
  usdcContractAddress?: string | null;
  defaultChainId: number;
  supportedChainIds: number[];
}

const Web3Context = createContext<Web3ContextType | undefined>(undefined);

export function useWeb3() {
  const context = useContext(Web3Context);
  if (!context) {
    throw new Error("useWeb3 must be used within a Web3Provider");
  }
  return context;
}

// ============================================================================
// WEB3 PROVIDER
// Wraps the app with Wagmi and React Query providers
// ============================================================================

interface Web3ProviderProps {
  children: ReactNode;
}

export function Web3Provider({ children }: Web3ProviderProps) {
  const queryClient = getQueryClient();
  const [treasuryAddress] = useState(TREASURY_ADDRESS);

  const web3ContextValue: Web3ContextType = {
    treasuryAddress,
    usdcContractAddress: USDC_CONTRACT_ADDRESS,
    defaultChainId: defaultChain.id,
    supportedChainIds: chains.map((c) => c.id),
  };

  return (
    <Web3Context.Provider value={web3ContextValue}>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </WagmiProvider>
    </Web3Context.Provider>
  );
}

// ============================================================================
// EXPORTS
// Re-export commonly used wagmi hooks for convenience
// ============================================================================

export { useAccount, useConnect, useDisconnect, useSendTransaction, useWaitForTransactionReceipt, useBalance, useReadContract, useWriteContract } from "wagmi";
export { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
