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

import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  type PublicClient,
  type WalletClient,
  type WaitForTransactionReceiptParameters,
  type WaitForTransactionReceiptReturnType,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, HttpTransport, Account, Chain } from "viem";
import {
  getRpcFallbackChain,
  getDefaultChain,
  getChainConfig,
  type SupportedChainId,
} from "./config";

// ============================================================================
// SERVERLESS TIMEOUT CONFIGURATION
// ============================================================================

/**
 * Maximum wait time for transaction receipts in serverless environments.
 * Vercel serverless functions have a 10-second timeout (Hobby tier).
 * We use 8 seconds to leave a 2-second buffer for cleanup and response.
 */
const SERVERLESS_WAIT_TIMEOUT_MS = 8000;

/**
 * Polling interval for transaction receipt checks.
 * Frequent polling (1s) ensures we detect confirmation as soon as possible.
 */
const SERVERLESS_POLLING_INTERVAL_MS = 1000;

/**
 * Error thrown when a transaction receipt wait exceeds the serverless timeout.
 * This is marked as retryable so QStash can safely pick it up on the next sweep.
 */
export class ServerlessTimeoutError extends Error {
  public readonly retryable = true;
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `Transaction receipt wait exceeded serverless timeout of ${timeoutMs}ms. ` +
        `The transaction may still confirm — this is retryable via QStash.`,
    );
    this.name = "ServerlessTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

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

  const baseClient = createPublicClient({
    chain: chainConfig.chain,
    transport,
  });

  return wrapClientWithServerlessTimeout(baseClient);
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

  const baseClient = createWalletClient({
    chain: chainConfig.chain,
    transport,
    account,
  });

  return wrapWalletClientWithServerlessTimeout(baseClient);
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

// ============================================================================
// SERVERLESS TIMEOUT WRAPPERS
// ============================================================================

/**
 * Wrap a public client to enforce serverless-safe timeouts on
 * waitForTransactionReceipt. This prevents Vercel 504 errors by
 * throwing a retryable ServerlessTimeoutError if the tx doesn't confirm
 * within the timeout window.
 */
function wrapClientWithServerlessTimeout<TChain extends Chain>(
  client: PublicClient<HttpTransport, TChain>,
): PublicClient<HttpTransport, TChain> {
  const originalWait = client.waitForTransactionReceipt.bind(client);

  const wrappedWait = async (
    params: WaitForTransactionReceiptParameters,
  ): Promise<WaitForTransactionReceiptReturnType> => {
    const { hash } = params;
    const timeoutMs = params.timeout ?? SERVERLESS_WAIT_TIMEOUT_MS;
    const pollingInterval =
      params.pollingInterval ?? SERVERLESS_POLLING_INTERVAL_MS;

    const startTime = Date.now();

    while (true) {
      try {
        // Use viem's built-in timeout mechanism
        return await originalWait({
          ...params,
          timeout: timeoutMs,
          pollingInterval,
        });
      } catch (error) {
        // If we've exceeded our serverless budget, throw a retryable error
        const elapsed = Date.now() - startTime;
        if (elapsed >= SERVERLESS_WAIT_TIMEOUT_MS) {
          throw new ServerlessTimeoutError(SERVERLESS_WAIT_TIMEOUT_MS);
        }
        // Otherwise re-throw if it's a non-timeout error
        throw error;
      }
    }
  };

  return client.extend({
    waitForTransactionReceipt: {
      fn: wrappedWait,
    },
  }) as PublicClient<HttpTransport, TChain>;
}

/**
 * Wrap a wallet client to enforce serverless-safe timeouts on
 * waitForTransactionReceipt.
 */
function wrapWalletClientWithServerlessTimeout<TChain extends Chain>(
  client: WalletClient<HttpTransport, TChain, Account>,
): WalletClient<HttpTransport, TChain, Account> {
  const originalWait = client.waitForTransactionReceipt.bind(client);

  const wrappedWait = async (
    params: WaitForTransactionReceiptParameters,
  ): Promise<WaitForTransactionReceiptReturnType> => {
    const { hash } = params;
    const timeoutMs = params.timeout ?? SERVERLESS_WAIT_TIMEOUT_MS;
    const pollingInterval =
      params.pollingInterval ?? SERVERLESS_POLLING_INTERVAL_MS;

    const startTime = Date.now();

    while (true) {
      try {
        return await originalWait({
          ...params,
          timeout: timeoutMs,
          pollingInterval,
        });
      } catch (error) {
        const elapsed = Date.now() - startTime;
        if (elapsed >= SERVERLESS_WAIT_TIMEOUT_MS) {
          throw new ServerlessTimeoutError(SERVERLESS_WAIT_TIMEOUT_MS);
        }
        throw error;
      }
    }
  };

  return client.extend({
    waitForTransactionReceipt: {
      fn: wrappedWait,
    },
  }) as WalletClient<HttpTransport, TChain, Account>;
}
