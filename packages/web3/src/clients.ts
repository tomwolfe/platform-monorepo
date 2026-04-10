/**
 * Web3 Client Factories
 *
 * Centralized viem client creation with RPC fallback chains.
 * Eliminates duplicate client factory logic across apps.
 *
 * Usage:
 * ```typescript
 * import { getPublicClient, getWalletClient } from "@repo/web3/clients";
 *
 * // Read from blockchain
 * const client = getPublicClient("base");
 * const block = await client.getBlockNumber();
 *
 * // Write to blockchain (requires private key)
 * const wallet = getWalletClient("0x...", privateKey);
 * const hash = await wallet.sendTransaction({ ... });
 * ```
 *
 * @package @repo/web3
 */

import { createPublicClient, createWalletClient, http, fallback } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, HttpTransport, Account, Chain } from "viem";
import {
  getRpcFallbackChain,
  getDefaultChain,
  getChainConfig,
  type SupportedChainId,
} from "./config";

// ============================================================================
// PUBLIC CLIENT (Read-only)
// ============================================================================

/**
 * Get a public (read-only) viem client for a chain
 *
 * @param chainName - Chain name (defaults to "base")
 * @returns Viem public client instance
 *
 * @example
 * ```typescript
 * const client = getPublicClient("base");
 * const balance = await client.getBalance({ address });
 * ```
 */
export function getPublicClient(chainName: SupportedChainId = "base") {
  const chainConfig = getChainConfig(chainName);
  const transport = getRpcFallbackChain(chainName);

  return createPublicClient({
    chain: chainConfig.chain,
    transport,
  });
}

/**
 * Get public clients for all supported chains
 *
 * @returns Map of chain name to public client
 */
export function getAllPublicClients() {
  const chains: SupportedChainId[] = ["base", "polygon", "ethereum"];
  const clients: Map<
    SupportedChainId,
    ReturnType<typeof getPublicClient>
  > = new Map();

  for (const chain of chains) {
    clients.set(chain, getPublicClient(chain));
  }

  return clients;
}

// ============================================================================
// WALLET CLIENT (Write)
// ============================================================================

/**
 * Get a wallet (write) client for signing transactions
 *
 * @param address - Wallet address
 * @param privateKey - Private key (0x-prefixed)
 * @param chainName - Chain name (defaults to "base")
 * @returns Viem wallet client instance
 *
 * @example
 * ```typescript
 * const wallet = getWalletClient(address, process.env.WALLET_PRIVATE_KEY);
 * const hash = await wallet.sendTransaction({ to, value });
 * ```
 */
export function getWalletClient(
  address: Address,
  privateKey: `0x${string}`,
  chainName: SupportedChainId = "base",
) {
  const chainConfig = getChainConfig(chainName);
  const account = privateKeyToAccount(privateKey);
  const transport = getRpcFallbackChain(chainName);

  return createWalletClient({
    chain: chainConfig.chain,
    transport,
    account,
  });
}

// ============================================================================
// SIMPLIFIED CLIENTS (Default Chain)
// ============================================================================

/**
 * Get public client for the default chain (Base)
 */
export function getDefaultPublicClient() {
  const chain = getDefaultChain();
  const transport = getRpcFallbackChain("base");

  return createPublicClient({
    chain,
    transport,
  });
}

/**
 * Get wallet client for the default chain (Base)
 */
export function getDefaultWalletClient(
  address: Address,
  privateKey: `0x${string}`,
) {
  return getWalletClient(address, privateKey, "base");
}
