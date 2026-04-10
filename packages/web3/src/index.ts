/**
 * @repo/web3 - Shared Web3/Blockchain Client Package
 *
 * Centralized viem client management, chain configuration, and RPC fallback logic.
 * Eliminates duplicate Web3 code across table-stack and open-delivery apps.
 *
 * Usage:
 * ```typescript
 * import { getPublicClient, getChainConfig } from "@repo/web3";
 *
 * const client = getPublicClient("base");
 * const block = await client.getBlockNumber();
 * ```
 *
 * @package @repo/web3
 */

// ============================================================================
// CLIENT FACTORIES
// ============================================================================

export {
  getPublicClient,
  getAllPublicClients,
  getWalletClient,
  getDefaultPublicClient,
  getDefaultWalletClient,
} from "./clients";

// ============================================================================
// CHAIN CONFIGURATION
// ============================================================================

export {
  CHAIN_CONFIG,
  DEFAULT_CHAIN,
  getChainConfig,
  getRpcFallbackChain,
  getRpcUrlsForChain,
  getDefaultChain,
  type SupportedChainId,
} from "./config";

// ============================================================================
// TYPES
// ============================================================================

export type {
  // Viem types
  Address,
  Hash,
  Hex,
  TransactionReceipt,
  Transaction,
  Log,
  Block,
  Account,
  Chain,
  PublicClient,
  WalletClient,

  // Domain types
  EscrowEvent,
  TransactionVerificationResult,
  Web3TransactionParams,
  ChainMetadata,
} from "./types";
