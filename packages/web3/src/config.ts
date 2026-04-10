/**
 * Web3 Chain Configuration
 *
 * Centralized configuration for blockchain networks, RPC endpoints,
 * and fallback chains. Eliminates duplication across apps.
 *
 * Usage:
 * ```typescript
 * import { getChainConfig, getRpcFallbackChain } from "@repo/web3/config";
 * import { getPublicClient } from "@repo/web3/clients";
 * ```
 *
 * @package @repo/web3
 */

import { fallback, http } from "viem";
import { base, polygon, mainnet } from "viem/chains";
import type { Chain } from "viem";

// ============================================================================
// CHAIN CONFIGURATIONS
// ============================================================================

/**
 * Supported chain IDs and their metadata
 */
export const CHAIN_CONFIG = {
  base: {
    chain: base,
    name: "Base",
    nativeCurrency: "ETH",
    escrowContract: process.env
      .NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS as `0x${string}`,
    treasuryWallet: process.env
      .NEXT_PUBLIC_TREASURY_WALLET_ADDRESS as `0x${string}`,
    minConfirmations: parseInt(
      process.env.NEXT_PUBLIC_MIN_CONFIRMATIONS || "3",
      10,
    ),
  },
  polygon: {
    chain: polygon,
    name: "Polygon",
    nativeCurrency: "MATIC",
    escrowContract: undefined,
    treasuryWallet: undefined,
    minConfirmations: parseInt(
      process.env.NEXT_PUBLIC_MIN_CONFIRMATIONS || "3",
      10,
    ),
  },
  ethereum: {
    chain: mainnet,
    name: "Ethereum",
    nativeCurrency: "ETH",
    escrowContract: undefined,
    treasuryWallet: undefined,
    minConfirmations: parseInt(
      process.env.NEXT_PUBLIC_MIN_CONFIRMATIONS || "3",
      10,
    ),
  },
} as const;

export type SupportedChainId = keyof typeof CHAIN_CONFIG;

/**
 * Get chain config by chain ID or name
 */
export function getChainConfig(
  chainIdOrName: SupportedChainId | number | string,
) {
  if (typeof chainIdOrName === "string" && chainIdOrName in CHAIN_CONFIG) {
    return CHAIN_CONFIG[chainIdOrName as SupportedChainId];
  }

  // Lookup by chain ID
  for (const [key, config] of Object.entries(CHAIN_CONFIG)) {
    if (config.chain.id === chainIdOrName) {
      return config;
    }
  }

  throw new Error(`Unsupported chain: ${chainIdOrName}`);
}

// ============================================================================
// RPC FALLBACK CHAINS
// ============================================================================

/**
 * RPC URL environment variables
 */
const RPC_ENV_VARS = {
  base: "BASE_RPC_URL",
  polygon: "POLYGON_RPC_URL",
  ethereum: "ETHEREUM_RPC_URL",
} as const;

/**
 * Public fallback RPC URLs (used when custom RPC not configured)
 * WARNING: These are rate-limited. Configure your own RPC URLs for production.
 */
const PUBLIC_FALLBACKS = {
  base: [
    "https://mainnet.base.org",
    "https://base.llamarpc.com",
    "https://base.publicnode.com",
  ],
  polygon: [
    "https://polygon-rpc.com",
    "https://polygon.llamarpc.com",
    "https://rpc.ankr.com/polygon",
  ],
  ethereum: [
    "https://eth.llamarpc.com",
    "https://cloudflare-eth.com",
    "https://rpc.ankr.com/eth",
  ],
} as const;

/**
 * Build RPC fallback chain for a network
 *
 * @param chainName - Chain name (base, polygon, ethereum)
 * @returns Viem fallback transport with configured RPC URLs
 */
export function getRpcFallbackChain(chainName: SupportedChainId) {
  const envVarName = RPC_ENV_VARS[chainName];
  const customRpcUrl = process.env[envVarName];

  const isProduction = process.env.NODE_ENV === "production";

  // In production, require custom RPC URLs to avoid rate limiting
  if (isProduction && !customRpcUrl) {
    throw new Error(
      `${envVarName} environment variable is required in production. ` +
        `Public fallback URLs are disabled to prevent rate-limiting issues.`,
    );
  }

  // Build URL list with custom RPC first, then public fallbacks
  const urls = customRpcUrl
    ? [customRpcUrl, ...PUBLIC_FALLBACKS[chainName]]
    : PUBLIC_FALLBACKS[chainName];

  return fallback(urls.map((url) => http(url)));
}

/**
 * Get RPC URLs for a chain (for debugging/logging)
 */
export function getRpcUrlsForChain(
  chainName: SupportedChainId,
): readonly string[] {
  const customRpcUrl = process.env[RPC_ENV_VARS[chainName]];
  return customRpcUrl
    ? [customRpcUrl, ...PUBLIC_FALLBACKS[chainName]]
    : PUBLIC_FALLBACKS[chainName];
}

// ============================================================================
// DEFAULT CHAIN
// ============================================================================

/**
 * Default chain for the application (Base)
 */
export const DEFAULT_CHAIN: SupportedChainId = "base";

/**
 * Get the default chain viem config
 */
export function getDefaultChain(): Chain {
  return CHAIN_CONFIG[DEFAULT_CHAIN].chain;
}
