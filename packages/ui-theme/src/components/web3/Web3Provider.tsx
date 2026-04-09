"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import {
  WagmiProvider,
  createConfig,
  http,
  type Config as WagmiConfig,
} from "wagmi";
import { base, polygon, mainnet } from "wagmi/chains";
import { coinbaseWallet, metaMask } from "wagmi/connectors";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createStorage, fallback } from "wagmi";
import { getQueryClient } from "../lib/query-client";

/**
 * T3.1: Consolidated Web3 Provider Component
 *
 * Single source of truth for WagmiConfig + QueryClient setup across all apps.
 * Configurable via props so each app can customize appName, chains, and RPC URLs.
 *
 * @package @repo/ui-theme
 * @since 1.0.0
 *
 * @example
 * ```tsx
 * // TableStack (DIRECT_P2P mode)
 * <Web3Provider
 *   appName="Table-Stack"
 *   appLogoUrl="🍽️"
 *   defaultChain={base}
 *   chains={[base, polygon, mainnet]}
 * >
 *   {children}
 * </Web3Provider>
 *
 * // Open-Delivery (ESCROW mode)
 * <Web3Provider
 *   appName="OpenDeliver"
 *   appLogoUrl="🚚"
 *   defaultChain={base}
 *   chains={[base, polygon, mainnet]}
 *   escrowContractAddress="0x..."
 * >
 *   {children}
 * </Web3Provider>
 * ```
 */

// ============================================================================
// DEFAULTS
// ============================================================================

const DEFAULT_CHAINS = [base, polygon, mainnet] as const;
const DEFAULT_CHAIN = base; // Base for low fees and fast transactions

// ============================================================================
// TYPES
// ============================================================================

export interface Web3ProviderProps {
  children: ReactNode;
  /** App name shown in wallet connectors (default: "Platform") */
  appName?: string;
  /** App logo URL or emoji shown in wallet connectors (default: "🔗") */
  appLogoUrl?: string;
  /** Default chain (default: Base) */
  defaultChain?: typeof base | typeof polygon | typeof mainnet;
  /** Supported chains (default: [base, polygon, mainnet]) */
  chains?:
    | readonly [typeof base, typeof polygon, typeof mainnet]
    | (typeof base)[];
  /** Escrow contract address (for Open-Delivery escrow mode) */
  escrowContractAddress?: string;
  /** USDC contract address */
  usdcContractAddress?: string;
  /** Platform fee wallet address */
  platformFeeWallet?: string;
  /** Custom wagmi config (overrides all other config props) */
  wagmiConfig?: WagmiConfig;
  /** Custom RPC URLs for chains */
  rpcUrls?: {
    base?: string;
    polygon?: string;
    ethereum?: string;
  };
}

export interface Web3ContextType {
  escrowContractAddress: string;
  usdcContractAddress?: string | null;
  defaultChainId: number;
  supportedChainIds: number[];
  platformFeeWallet?: string;
  isConfigured: boolean;
}

// ============================================================================
// CONTEXT
// ============================================================================

const Web3Context = createContext<Web3ContextType | undefined>(undefined);

export function useWeb3() {
  const context = useContext(Web3Context);
  if (!context) {
    throw new Error("useWeb3 must be used within a Web3Provider");
  }
  return context;
}

// ============================================================================
// WAGMI CONFIG FACTORY
// ============================================================================

/**
 * Create a wagmi config from the provided options.
 * This allows each app to customize the wagmi setup while sharing the same logic.
 */
function createWagmiConfig(options: Web3ProviderProps): WagmiConfig {
  const {
    appName = "Platform",
    appLogoUrl = "🔗",
    defaultChain = DEFAULT_CHAIN,
    chains = DEFAULT_CHAINS,
    rpcUrls = {},
  } = options;

  const storage = createStorage({
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
    key: "wagmi.store",
  });

  // Build transports with configurable RPC URLs
  const transports: Record<number, ReturnType<typeof fallback>> = {};
  for (const chain of chains) {
    const chainId = chain.id;
    let rpcUrl: string;
    switch (chainId) {
      case base.id:
        rpcUrl = rpcUrls.base || "https://mainnet.base.org";
        break;
      case polygon.id:
        rpcUrl = rpcUrls.polygon || "https://polygon-rpc.com";
        break;
      case mainnet.id:
        rpcUrl = rpcUrls.ethereum || "https://eth.llamarpc.com";
        break;
      default:
        rpcUrl = chain.rpcUrls.default.http[0];
    }
    transports[chainId] = fallback([http(), http(rpcUrl)]);
  }

  return createConfig({
    chains: [
      defaultChain,
      ...(chains as typeof DEFAULT_CHAINS),
    ] as typeof DEFAULT_CHAINS,
    ssr: true,
    storage,
    transports: transports as typeof transports,
    connectors: [
      coinbaseWallet({
        appName,
        appLogoUrl,
      }),
      metaMask(),
    ],
  });
}

// ============================================================================
// WEB3 PROVIDER
// ============================================================================

export function Web3Provider({
  children,
  appName = "Platform",
  appLogoUrl = "🔗",
  defaultChain = DEFAULT_CHAIN,
  chains = DEFAULT_CHAINS,
  escrowContractAddress = "",
  usdcContractAddress,
  platformFeeWallet,
  wagmiConfig,
  rpcUrls,
}: Web3ProviderProps) {
  const queryClient = getQueryClient();
  const config =
    wagmiConfig ??
    createWagmiConfig({
      appName,
      appLogoUrl,
      defaultChain,
      chains,
      rpcUrls,
    });

  const web3ContextValue = useMemo<Web3ContextType>(
    () => ({
      escrowContractAddress,
      usdcContractAddress: usdcContractAddress || null,
      defaultChainId: defaultChain.id,
      supportedChainIds: chains.map((c) => c.id),
      platformFeeWallet,
      isConfigured: true,
    }),
    [
      escrowContractAddress,
      usdcContractAddress,
      defaultChain.id,
      chains,
      platformFeeWallet,
    ],
  );

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
// RE-EXPORTS
// Convenience re-exports for commonly used wagmi and react-query hooks
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
