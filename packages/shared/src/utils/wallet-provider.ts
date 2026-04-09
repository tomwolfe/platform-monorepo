/**
 * Wallet Provider Abstraction
 *
 * Problem Solved: Web3 Private Key Coupling
 * - Raw private keys were instantiated directly from process.env in business logic
 * - Created tight coupling to environment variables and viem's privateKeyToAccount
 * - Made it difficult to migrate to AWS KMS, Fireblocks, or other HSM solutions
 *
 * Solution: Centralized Wallet Provider
 * - Abstracts account creation behind a unified interface
 * - Single point of migration for future KMS/HSM integration
 * - Validates and throws descriptive errors if keys are missing
 * - Supports multiple chains with proper type safety
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  fallback,
  type Address,
  type WalletClient,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  getNextNonce,
  peekNonce,
  resetNonce,
  syncNonceFromChain,
  checkNonceSyncStatus,
} from "./nonce-tracker";
export {
  createTracedPublicClient,
  getCurrentTraceId,
  logWithTraceContext,
} from "./web3-tracer";
import {
  getChainConfig,
  isSupportedChain,
  SUPPORTED_CHAIN_IDS,
  DEFAULT_CHAIN_ID,
} from "../config/web3-chains";

// ============================================================================
// TYPES
// ============================================================================

export interface WalletProviderOptions {
  chainId: number;
  privateKey?: string; // Optional: defaults to ESCROW_RESOLVER_PRIVATE_KEY
}

export type WalletClientInstance = ReturnType<typeof createWalletClient>;
export type PublicClientInstance = ReturnType<typeof createPublicClient>;

// ============================================================================
// WALLET PROVIDER
// ============================================================================

/**
 * Get an escrow resolver wallet client
 *
 * This is the ONLY function that should be used to create wallet clients for
 * escrow-related operations. It centralizes private key handling and makes
 * it easy to swap in AWS KMS, Fireblocks, or other HSM solutions later.
 *
 * @param chainId - The chain ID to connect to (defaults to Base)
 * @returns WalletClient configured with the escrow resolver account
 * @throws Error if ESCROW_RESOLVER_PRIVATE_KEY is not configured
 *
 * @example
 * ```typescript
 * const walletClient = await getEscrowResolverWalletClient(DEFAULT_CHAIN_ID);
 * const hash = await walletClient.writeContract({ ... });
 * ```
 */
export async function getEscrowResolverWalletClient(
  chainId: number = DEFAULT_CHAIN_ID,
): Promise<WalletClient> {
  if (!isSupportedChain(chainId)) {
    throw new Error(
      `Unsupported chain ID: ${chainId}. Supported chains: ${SUPPORTED_CHAIN_IDS.join(", ")}`,
    );
  }

  const chainConfig = getChainConfig(chainId);

  // Get private key from centralized config (already has validation)
  const privateKey = process.env.ESCROW_RESOLVER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      "ESCROW_RESOLVER_PRIVATE_KEY environment variable is not configured. " +
        "This is required for escrow contract interactions.",
    );
  }

  // Create account from private key
  // MIGRATION NOTE: To migrate to AWS KMS or Fireblocks, replace this line with:
  //   const account = await kmsAccountProvider.getAccount(privateKeyId);
  const account = privateKeyToAccount(privateKey as `0x${string}`);

  // Create wallet client with fallback RPC URLs
  const walletClient = createWalletClient({
    account,
    chain: chainConfig.chain,
    transport: fallback(chainConfig.getServerRpcUrls().map((url) => http(url))),
  });

  return walletClient;
}

/**
 * Get a public client for blockchain reads
 *
 * @param chainId - The chain ID to connect to (defaults to Base)
 * @returns PublicClient for reading blockchain state
 *
 * @example
 * ```typescript
 * const publicClient = await getPublicClient(DEFAULT_CHAIN_ID);
 * const balance = await publicClient.getBalance({ address });
 * ```
 */
export async function getPublicClient(
  chainId: number = DEFAULT_CHAIN_ID,
): Promise<PublicClient> {
  if (!isSupportedChain(chainId)) {
    throw new Error(
      `Unsupported chain ID: ${chainId}. Supported chains: ${SUPPORTED_CHAIN_IDS.join(", ")}`,
    );
  }

  const chainConfig = getChainConfig(chainId);

  const publicClient = createPublicClient({
    chain: chainConfig.chain,
    transport: fallback(chainConfig.getServerRpcUrls().map((url) => http(url))),
  });

  return publicClient;
}

/**
 * Get wallet client with custom private key
 *
 * Use this for operations that need a different key than the escrow resolver.
 * WARNING: This bypasses the centralized private key management. Use with caution.
 *
 * @param privateKey - The private key to use (must be 0x-prefixed hex string)
 * @param chainId - The chain ID to connect to
 * @returns WalletClient configured with the provided key
 *
 * @example
 * ```typescript
 * const walletClient = await getCustomWalletClient('0x...', DEFAULT_CHAIN_ID);
 * ```
 */
export async function getCustomWalletClient(
  privateKey: string,
  chainId: number = DEFAULT_CHAIN_ID,
): Promise<WalletClient> {
  if (!isSupportedChain(chainId)) {
    throw new Error(
      `Unsupported chain ID: ${chainId}. Supported chains: ${SUPPORTED_CHAIN_IDS.join(", ")}`,
    );
  }

  const chainConfig = getChainConfig(chainId);

  const account = privateKeyToAccount(privateKey as `0x${string}`);

  const walletClient = createWalletClient({
    account,
    chain: chainConfig.chain,
    transport: fallback(chainConfig.getServerRpcUrls().map((url) => http(url))),
  });

  return walletClient;
}

/**
 * Get the address of the escrow resolver wallet
 *
 * Useful for displaying or logging the resolver address without
 * creating a full wallet client.
 *
 * @returns The resolver wallet address
 *
 * @example
 * ```typescript
 * const resolverAddress = await getEscrowResolverAddress();
 * console.log(`Using resolver: ${resolverAddress}`);
 * ```
 */
export async function getEscrowResolverAddress(): Promise<Address> {
  const privateKey = process.env.ESCROW_RESOLVER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      "ESCROW_RESOLVER_PRIVATE_KEY environment variable is not configured",
    );
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return account.address;
}

/**
 * Validate that the escrow resolver private key is properly configured
 *
 * Call this during application startup to fail fast if the key is missing.
 *
 * @returns true if configuration is valid
 * @throws Error if configuration is invalid
 */
export function validateEscrowResolverConfig(): boolean {
  const privateKey = process.env.ESCROW_RESOLVER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      "CRITICAL: ESCROW_RESOLVER_PRIVATE_KEY is not configured. " +
        "This is required for Web3 escrow operations. " +
        "Set a 0x-prefixed hex private key in your environment variables.",
    );
  }

  if (!privateKey.startsWith("0x")) {
    throw new Error(
      "ESCROW_RESOLVER_PRIVATE_KEY must be a 0x-prefixed hex string",
    );
  }

  if (privateKey.length !== 66) {
    throw new Error(
      `ESCROW_RESOLVER_PRIVATE_KEY has invalid length: ${privateKey.length} (expected 66)`,
    );
  }

  return true;
}

// ============================================================================
// GAS & NONCE UTILITIES
// ============================================================================

/**
 * Get dynamic gas price with a 10% safety buffer.
 * @param publicClient - Viem public client
 * @returns Gas price with safety buffer
 */
export async function getDynamicGasPrice<
  T extends { getGasPrice: () => Promise<bigint> },
>(publicClient: T): Promise<{ gasPrice: bigint }> {
  const gasPrice = await publicClient.getGasPrice();
  // Apply 10% safety buffer: gasPrice * 110 / 100
  const bufferedGasPrice = (gasPrice * 110n) / 100n;
  return { gasPrice: bufferedGasPrice };
}

/**
 * Estimate transaction gas with a 20% safety buffer.
 * @param params - Estimation parameters
 * @returns Estimated gas limit with buffer
 */
export async function estimateTransactionGas(params: {
  publicClient: { estimateGas: (args: any) => Promise<bigint> };
  account: { address: `0x${string}` };
  to: `0x${string}`;
  data: `0x${string}`;
}): Promise<bigint> {
  const estimated = await params.publicClient.estimateGas({
    account: params.account.address,
    to: params.to,
    data: params.data,
  });
  // Apply 20% safety buffer
  return (estimated * 120n) / 100n;
}

/**
 * Nonce management helpers integrated with the wallet client.
 */
export const nonceManager = {
  getNextNonce: async (
    chainId: number,
    address: string,
    publicClient: PublicClient,
    startNonce?: number,
  ) => getNextNonce(chainId, address, publicClient, startNonce),
  peekNonce,
  resetNonce,
  syncNonceFromChain,
  checkNonceSyncStatus,
};
