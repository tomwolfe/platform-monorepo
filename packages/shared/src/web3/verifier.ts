/**
 * Unified Web3 Verifier
 *
 * SINGLE SOURCE OF TRUTH for Web3 validation helpers across all apps.
 * Consolidates hex/address validation from table-stack and open-delivery.
 *
 * This module provides:
 * - Safe hex/address validation with configurable error handling (throw vs return null)
 * - Web3Provider singleton for viem client management with retry logic
 * - Common validation utilities used by checkout and pending-order verification
 *
 * @see T1: Unify Web3 Logic - Audit Roadmap
 */

import {
  isHex,
  isAddress,
  type Address,
  type Hash,
  createPublicClient,
  http,
  fallback,
} from "viem";
import { base, polygon, mainnet } from "viem/chains";
import type { PublicClient } from "viem";
import { Logger } from "../logger";

const logger = new Logger({ serviceName: "web3-verifier" });

// ============================================================================
// RPC URL CONFIGURATION
// ============================================================================

const RPC_URLS = {
  base: (() => {
    const primary = process.env.BASE_RPC_URL;
    if (!primary && process.env.NODE_ENV === "production") {
      logger.error("BASE_RPC_URL is required in production");
    }
    return [
      primary || "https://mainnet.base.org",
      "https://base.llamarpc.com",
      "https://base.publicnode.com",
    ];
  })(),
  polygon: (() => {
    const primary = process.env.POLYGON_RPC_URL;
    if (!primary && process.env.NODE_ENV === "production") {
      logger.error("POLYGON_RPC_URL is required in production");
    }
    return [
      primary || "https://polygon-rpc.com",
      "https://polygon.llamarpc.com",
      "https://polygon.publicnode.com",
    ];
  })(),
  ethereum: (() => {
    const primary = process.env.ETHEREUM_RPC_URL;
    if (!primary && process.env.NODE_ENV === "production") {
      logger.error("ETHEREUM_RPC_URL is required in production");
    }
    return [
      primary || "https://eth-mainnet.g.alchemy.com/v2/demo",
      "https://eth.llamarpc.com",
      "https://ethereum.publicnode.com",
    ];
  })(),
};

// ============================================================================
// WEB3 PROVIDER (Singleton with Retry Logic)
// ============================================================================

/**
 * Web3Provider manages viem client singletons with automatic retry on RPC timeout.
 * This prevents duplicate client creation across apps and handles transient RPC failures.
 */
export class Web3Provider {
  private static clients: Map<number, PublicClient> = new Map();
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_DELAY_MS = 1000;

  /**
   * Get or create a public client for the specified chain.
   * Clients are cached as singletons to avoid redundant initialization.
   */
  static getClient(chainId?: number): PublicClient {
    const chain = chainId || base.id;

    if (this.clients.has(chain)) {
      return this.clients.get(chain)!;
    }

    const client = this.createClient(chain);
    this.clients.set(chain, client);
    return client;
  }

  /**
   * Create a new public client with fallback RPC URLs.
   */
  private static createClient(chainId: number): PublicClient {
    if (chainId === polygon.id) {
      return createPublicClient({
        chain: polygon,
        transport: fallback(RPC_URLS.polygon.map((url) => http(url))),
      }) as PublicClient;
    }

    if (chainId === mainnet.id) {
      return createPublicClient({
        chain: mainnet,
        transport: fallback(RPC_URLS.ethereum.map((url) => http(url))),
      }) as PublicClient;
    }

    // Default to Base
    return createPublicClient({
      chain: base,
      transport: fallback(RPC_URLS.base.map((url) => http(url))),
    }) as PublicClient;
  }

  /**
   * Execute an RPC call with automatic retry on timeout.
   * Uses exponential backoff between retries.
   */
  static async withRetry<T>(
    operation: (client: PublicClient) => Promise<T>,
    chainId?: number,
    maxRetries: number = this.MAX_RETRIES,
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const client = this.getClient(chainId);
        return await operation(client);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Only retry on timeout/network errors
        const isRetryable =
          lastError.message.toLowerCase().includes("timeout") ||
          lastError.message.toLowerCase().includes("network") ||
          lastError.message.toLowerCase().includes("econnreset");

        if (!isRetryable || attempt === maxRetries) {
          logger.error("RPC call failed after retries", {
            attempt,
            maxRetries,
            error: lastError.message,
            chainId,
          });
          throw lastError;
        }

        // Exponential backoff: 1s, 2s, 4s
        const delay = this.RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn(
          `RPC call failed, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`,
          {
            error: lastError.message,
          },
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // This should never be reached due to the throw above
    throw lastError!;
  }

  /**
   * Clear cached clients (useful for testing).
   */
  static clearCache(): void {
    this.clients.clear();
  }
}

// ============================================================================
// SAFE HEX VALIDATION
// ============================================================================

/**
 * Validation strategy for hex/address validation.
 * - 'throw': Throws a controlled error (use in user-facing flows like checkout)
 * - 'return-null': Returns null on invalid input (use in batch processing where you want to skip bad records)
 */
export type ValidationStrategy = "throw" | "return-null";

export interface ValidationResult<T> {
  success: boolean;
  value: T | null;
  error: string | null;
}

/**
 * Safely validate and coerce a string to a 0x-prefixed hex string.
 *
 * @param value - The value to validate as hex
 * @param label - Descriptive label for error messages (e.g., "txHash", "blockHash")
 * @param strategy - How to handle invalid input: 'throw' (default) or 'return-null'
 * @returns Hex string if valid, null if strategy is 'return-null' and input is invalid
 * @throws Error if strategy is 'throw' and input is invalid
 */
export function safeToHex(
  value: string,
  label: string,
  strategy: "throw",
): `0x${string}`;
export function safeToHex(
  value: string,
  label: string,
  strategy: "return-null",
): `0x${string}` | null;
export function safeToHex(
  value: string,
  label: string,
  strategy: ValidationStrategy = "throw",
): `0x${string}` | null {
  if (!isHex(value)) {
    const errorMsg = `Invalid hex format for ${label}: expected 0x-prefixed string`;

    if (strategy === "throw") {
      throw new Error(errorMsg);
    }

    logger.warn(errorMsg, { value, label });
    return null;
  }

  return value as `0x${string}`;
}

/**
 * Safely validate and coerce a string to an Ethereum address.
 *
 * @param value - The value to validate as an Ethereum address
 * @param strategy - How to handle invalid input: 'throw' (default) or 'return-null'
 * @returns Address if valid, null if strategy is 'return-null' and input is invalid
 * @throws Error if strategy is 'throw' and input is invalid
 */
export function safeToAddress(
  value: string | null | undefined,
  strategy: "throw",
): `0x${string}`;
export function safeToAddress(
  value: string | null | undefined,
  strategy: "return-null",
): `0x${string}` | null;
export function safeToAddress(
  value: string | null | undefined,
  strategy: ValidationStrategy = "throw",
): `0x${string}` | null {
  if (!value || !isAddress(value)) {
    const errorMsg = "Invalid Ethereum address format";

    if (strategy === "throw") {
      throw new Error(errorMsg);
    }

    logger.warn(errorMsg, { value });
    return null;
  }

  return value as `0x${string}`;
}

/**
 * Validate a transaction hash format.
 * This is a convenience wrapper around safeToHex with a standard label.
 *
 * @param txHash - The transaction hash to validate
 * @param strategy - How to handle invalid input
 * @returns Validated tx hash or null depending on strategy
 */
export function validateTransactionHash(
  txHash: string,
  strategy: ValidationStrategy = "throw",
): `0x${string}` | null {
  return safeToHex(txHash, "txHash", strategy);
}

/**
 * Generic hex validation that returns a result object.
 * Useful when you need to check validity without throwing or logging.
 */
export function isValidHex(value: string): boolean {
  return isHex(value);
}

/**
 * Generic address validation that returns a result object.
 */
export function isValidAddress(value: string | null | undefined): boolean {
  return !!value && isAddress(value);
}

/**
 * Batch validation utility.
 * Validates multiple hex strings or addresses and returns all failures.
 */
export function validateBatch(
  items: Record<
    string,
    { value: string | null | undefined; type: "hex" | "address" }
  >,
  strategy: ValidationStrategy = "return-null",
): Record<string, ValidationResult<string>> {
  const results: Record<string, ValidationResult<string>> = {};

  for (const [key, { value, type }] of Object.entries(items)) {
    if (type === "hex") {
      const validated = safeToHex(value || "", key, strategy);
      results[key] = {
        success: validated !== null,
        value: validated,
        error: validated ? null : `Invalid hex for ${key}`,
      };
    } else {
      const validated = safeToAddress(value, strategy);
      results[key] = {
        success: validated !== null,
        value: validated,
        error: validated ? null : `Invalid address for ${key}`,
      };
    }
  }

  return results;
}

// ============================================================================
// EXPORTS
// ============================================================================

// Re-export viem types for convenience
export type { Address, Hash, PublicClient };

// Re-export the shared verifyTransaction function to provide a single import point
export { verifyTransaction } from "../utils/web3-verification";
export type { TransactionVerificationResult } from "../utils/web3-verification";
