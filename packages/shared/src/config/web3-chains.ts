/**
 * Web3 Chain Configuration
 *
 * Problem Solved: Configuration Fragmentation
 * - RPC URLs and chain definitions were duplicated across:
 *   - packages/shared/src/utils/wallet-provider.ts (CHAIN_CONFIG)
 *   - packages/shared/src/services/transaction-speedup.ts (SPEED_UP_CONFIG.rpcUrls)
 *   - apps/open-delivery/src/components/Web3Provider.tsx (chains array + transports)
 *   - apps/table-stack/src/components/web3/Web3Provider.tsx (chains array + transports)
 *   - packages/shared/src/client.ts (BrowserConfig RPC URL getters)
 *
 * Solution: Single Source of Truth
 * - All chain metadata (viem chains, supported chain IDs, RPC URL getters) lives here
 * - Server-side code uses AppConfig/env var URLs
 * - Client-side code uses BrowserConfig/NEXT_PUBLIC_* URLs
 * - No more hardcoded RPC URL strings scattered across the codebase
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { base, polygon, mainnet, type Chain } from "viem/chains";

// ============================================================================
// PAYMENT MODE ENUM
// T1.3: Standardize Web3 Payment Config & Feature Flags
// ============================================================================

/**
 * Payment mode enum defining how Web3 payments are processed.
 *
 * - `DIRECT_P2P`: Payments go directly from customer to merchant wallet.
 *   Used by TableStack for restaurant reservation deposits.
 * - `ESCROW`: Payments are deposited into a non-custodial escrow smart contract
 *   that instantly routes subtotal to restaurant and locks the driver's tip.
 *   Used by Open-Delivery for food delivery orders.
 * - `DISABLED`: Web3 payments are disabled. The app should fall back to
 *   traditional payment methods (credit card, etc.).
 */
export enum PaymentMode {
  /** Direct peer-to-peer payment to merchant/restaurant wallet */
  DIRECT_P2P = "DIRECT_P2P",
  /** Non-custodial escrow smart contract payment */
  ESCROW = "ESCROW",
  /** Web3 payments disabled; use traditional payment methods */
  DISABLED = "DISABLED",
}

/**
 * Default payment mode if not explicitly configured.
 * TableStack uses DIRECT_P2P; Open-Delivery overrides to ESCROW.
 */
export const DEFAULT_PAYMENT_MODE: PaymentMode = PaymentMode.DIRECT_P2P;

// ============================================================================
// TYPES
// ============================================================================

export interface ChainRpcConfig {
  /** viem chain definition */
  chain: Chain;
  /** Human-readable chain key (e.g., "base", "polygon", "ethereum") */
  key: string;
  /** Server-side RPC URLs (from env vars, resolved at call time) */
  getServerRpcUrls: () => string[];
  /** Client-side RPC URL (from NEXT_PUBLIC_* env vars, resolved at call time) */
  getClientRpcUrl: () => string;
  /** Public fallback RPC URL (used when no env var is set) */
  publicRpcUrl: string;
}

export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number];

// ============================================================================
// CONSTANTS
// ============================================================================

/** All supported chain IDs in a single authoritative list */
export const SUPPORTED_CHAIN_IDS = [base.id, polygon.id, mainnet.id] as const;

/** Default chain for low-fee operations */
export const DEFAULT_CHAIN_ID = base.id;

// ============================================================================
// CHAIN CONFIGURATION REGISTRY
// ============================================================================

/**
 * Unified chain configuration registry.
 * Each entry defines:
 * - The viem chain object
 * - A human-readable key
 * - Server-side RPC URL getter (uses AppConfig / process.env without NEXT_PUBLIC_ prefix)
 * - Client-side RPC URL getter (uses NEXT_PUBLIC_* env vars)
 * - Public fallback URL (hardcoded public endpoint)
 */
const CHAIN_REGISTRY: Record<number, ChainRpcConfig> = {
  [base.id]: {
    chain: base,
    key: "base",
    getServerRpcUrls: () => {
      const primary = process.env.BASE_RPC_URL || "https://mainnet.base.org";
      return [
        primary,
        "https://base.llamarpc.com",
        "https://base.publicnode.com",
      ];
    },
    getClientRpcUrl: () =>
      process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org",
    publicRpcUrl: "https://mainnet.base.org",
  },
  [polygon.id]: {
    chain: polygon,
    key: "polygon",
    getServerRpcUrls: () => {
      const primary = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
      return [primary, "https://polygon.llamarpc.com"];
    },
    getClientRpcUrl: () =>
      process.env.NEXT_PUBLIC_POLYGON_RPC_URL || "https://polygon-rpc.com",
    publicRpcUrl: "https://polygon-rpc.com",
  },
  [mainnet.id]: {
    chain: mainnet,
    key: "ethereum",
    getServerRpcUrls: () => {
      const primary = process.env.ETHEREUM_RPC_URL;
      if (!primary && process.env.NODE_ENV === "production") {
        console.error(
          "[web3-chains] ETHEREUM_RPC_URL is not configured in production. " +
            "Transaction verification may fail due to rate-limited public fallbacks.",
        );
      }
      const fallbackUrl = primary || "https://eth.llamarpc.com";
      return [
        fallbackUrl,
        "https://cloudflare-eth.com",
        "https://rpc.ankr.com/eth",
      ];
    },
    getClientRpcUrl: () =>
      process.env.NEXT_PUBLIC_ETH_RPC_URL || "https://eth.llamarpc.com",
    publicRpcUrl: "https://eth.llamarpc.com",
  },
};

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Get chain configuration by chain ID.
 * Throws if the chain ID is not supported.
 *
 * @param chainId - The chain ID to look up
 * @returns ChainRpcConfig for the given chain ID
 */
export function getChainConfig(chainId: number): ChainRpcConfig {
  const config = CHAIN_REGISTRY[chainId];
  if (!config) {
    throw new Error(
      `Unsupported chain ID: ${chainId}. Supported chains: ${SUPPORTED_CHAIN_IDS.join(", ")}`,
    );
  }
  return config;
}

/**
 * Check if a chain ID is supported.
 */
export function isSupportedChain(chainId: number): boolean {
  return chainId in CHAIN_REGISTRY;
}

/**
 * Get all supported chain configurations.
 */
export function getAllChainConfigs(): ReadonlyMap<number, ChainRpcConfig> {
  return new Map(
    Object.entries(CHAIN_REGISTRY).map(([k, v]) => [Number(k), v]),
  );
}

/**
 * Get the viem chain object for a given chain ID.
 */
export function getChain(chainId: number): Chain {
  return getChainConfig(chainId).chain;
}

/**
 * Get the human-readable key for a chain (e.g., "base", "polygon", "ethereum").
 */
export function getChainKey(chainId: number): string {
  return getChainConfig(chainId).key;
}
