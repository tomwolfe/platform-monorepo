"use client";

import React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { getQueryClient } from "@repo/ui-theme";
import { WagmiProvider, createConfig, http } from "wagmi";
import { base, polygon, mainnet } from "wagmi/chains";
import { coinbaseWallet, metaMask } from "wagmi/connectors";
import { createContext, useContext, useState, type ReactNode } from "react";
import { createStorage, fallback } from "wagmi";

// ============================================================================
// CONFIGURATION
// Default to Base for low fees and fast transactions
// ============================================================================

const ESCROW_CONTRACT_ADDRESS =
  process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS || null;
const USDC_CONTRACT_ADDRESS =
  process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS || null;
const PLATFORM_FEE_WALLET = process.env.NEXT_PUBLIC_PLATFORM_FEE_WALLET || null;

// Warn if critical env vars are missing
if (!ESCROW_CONTRACT_ADDRESS) {
  console.warn(
    "[Web3] NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS is not set. Crypto payments will be disabled.",
  );
}
if (!PLATFORM_FEE_WALLET) {
  console.warn(
    "[Web3] NEXT_PUBLIC_PLATFORM_FEE_WALLET is not set. Crypto payments will be disabled.",
  );
}

// Supported chains for delivery payments
const chains = [base, polygon, mainnet] as const;
const defaultChain = base; // Base is default for low fees

// Create persistent storage for wagmi (optional, for session persistence)
const storage = createStorage({
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
  key: "wagmi.store",
});

// Create wagmi config with client auto-detection
// RPC URLs are configurable via environment variables, with public defaults as fallback
const config = createConfig({
  chains: [defaultChain, ...chains],
  ssr: true, // Enable SSR compatibility for Next.js
  storage,
  transports: {
    [base.id]: fallback([
      http(),
      http(process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org"),
    ]),
    [polygon.id]: fallback([
      http(),
      http(
        process.env.NEXT_PUBLIC_POLYGON_RPC_URL || "https://polygon-rpc.com",
      ),
    ]),
    [mainnet.id]: fallback([
      http(),
      http(process.env.NEXT_PUBLIC_ETH_RPC_URL || "https://eth.llamarpc.com"),
    ]),
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
// WEB3 CONTEXT
// For accessing Web3 state throughout the app
// Uses centralized QueryClient from @repo/ui-theme
// ============================================================================

interface Web3ContextType {
  escrowContractAddress: string | null;
  platformFeeWallet: string | null;
  usdcContractAddress: string | null;
  defaultChainId: number;
  supportedChainIds: number[];
  isConfigured: boolean; // True if all required env vars are set
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
  const [escrowContractAddress] = useState(ESCROW_CONTRACT_ADDRESS);

  const isConfigured = !!(ESCROW_CONTRACT_ADDRESS && PLATFORM_FEE_WALLET);

  const web3ContextValue: Web3ContextType = {
    escrowContractAddress,
    platformFeeWallet: PLATFORM_FEE_WALLET,
    usdcContractAddress: USDC_CONTRACT_ADDRESS,
    defaultChainId: defaultChain.id,
    supportedChainIds: chains.map((c) => c.id),
    isConfigured,
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

export {
  useAccount,
  useConnect,
  useDisconnect,
  useSendTransaction,
  useWaitForTransactionReceipt,
  useBalance,
  useReadContract,
  useWriteContract,
} from "wagmi";
export { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
