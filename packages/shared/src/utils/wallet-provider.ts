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
  type Chain,
  type WalletClient,
  type PublicClient,
  type Transport,
  type Account,
  type CustomTransport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, polygon, mainnet } from 'viem/chains';

// ============================================================================
// CONFIGURATION
// ============================================================================

interface ChainConfig {
  chain: Chain;
  rpcUrls: string[];
}

const CHAIN_CONFIG: Record<number, ChainConfig> = {
  [base.id]: {
    chain: base,
    rpcUrls: [
      process.env.BASE_RPC_URL || 'https://mainnet.base.org',
      'https://base.llamarpc.com',
      'https://base.publicnode.com',
    ],
  },
  [polygon.id]: {
    chain: polygon,
    rpcUrls: [
      process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
      'https://polygon.llamarpc.com',
    ],
  },
  [mainnet.id]: {
    chain: mainnet,
    rpcUrls: [
      process.env.ETHEREUM_RPC_URL || 'https://eth-mainnet.g.alchemy.com/v2/demo',
      'https://eth.llamarpc.com',
    ],
  },
};

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
 * const walletClient = await getEscrowResolverWalletClient(base.id);
 * const hash = await walletClient.writeContract({ ... });
 * ```
 */
export async function getEscrowResolverWalletClient(
  chainId: number = base.id
): Promise<WalletClient> {
  const chainConfig = CHAIN_CONFIG[chainId];
  if (!chainConfig) {
    throw new Error(`Unsupported chain ID: ${chainId}. Supported chains: ${Object.keys(CHAIN_CONFIG).join(', ')}`);
  }

  // Get private key from centralized config (already has validation)
  const privateKey = process.env.ESCROW_RESOLVER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      'ESCROW_RESOLVER_PRIVATE_KEY environment variable is not configured. ' +
      'This is required for escrow contract interactions.'
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
    transport: fallback(chainConfig.rpcUrls.map((url) => http(url))),
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
 * const publicClient = await getPublicClient(base.id);
 * const balance = await publicClient.getBalance({ address });
 * ```
 */
export async function getPublicClient(
  chainId: number = base.id
): Promise<PublicClient> {
  const chainConfig = CHAIN_CONFIG[chainId];
  if (!chainConfig) {
    throw new Error(`Unsupported chain ID: ${chainId}. Supported chains: ${Object.keys(CHAIN_CONFIG).join(', ')}`);
  }

  const publicClient = createPublicClient({
    chain: chainConfig.chain,
    transport: fallback(chainConfig.rpcUrls.map((url) => http(url))),
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
 * const walletClient = await getCustomWalletClient('0x...', base.id);
 * ```
 */
export async function getCustomWalletClient(
  privateKey: string,
  chainId: number = base.id
): Promise<WalletClient> {
  const chainConfig = CHAIN_CONFIG[chainId];
  if (!chainConfig) {
    throw new Error(`Unsupported chain ID: ${chainId}. Supported chains: ${Object.keys(CHAIN_CONFIG).join(', ')}`);
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);

  const walletClient = createWalletClient({
    account,
    chain: chainConfig.chain,
    transport: fallback(chainConfig.rpcUrls.map((url) => http(url))),
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
      'ESCROW_RESOLVER_PRIVATE_KEY environment variable is not configured'
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
      'ESCROW_RESOLVER_PRIVATE_KEY is not configured. ' +
      'This is required for Web3 escrow operations.'
    );
  }

  if (!privateKey.startsWith('0x')) {
    throw new Error(
      'ESCROW_RESOLVER_PRIVATE_KEY must be a 0x-prefixed hex string'
    );
  }

  if (privateKey.length !== 66) {
    throw new Error(
      `ESCROW_RESOLVER_PRIVATE_KEY has invalid length: ${privateKey.length} (expected 66)`
    );
  }

  return true;
}
