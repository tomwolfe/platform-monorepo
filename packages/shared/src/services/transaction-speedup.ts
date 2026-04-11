/**
 * Web3 Transaction Speed-Up Service
 *
 * Problem Solved: Stuck Transactions Due to Low Gas Fees
 * - Users submit transactions with low gas fees during network congestion
 * - Transactions remain pending for extended periods (>10 minutes)
 * - Orders/reservations are stuck waiting for confirmation
 *
 * Solution: Automated Transaction Re-submission with Gas Bump
 * - Monitors pending transactions via cron job
 * - Detects transactions pending > 10 minutes
 * - Re-submits with 20% higher gas fee (replacement transaction)
 * - Uses Escrow Resolver key for backend-initiated transactions
 *
 * Architecture:
 * 1. VerifyPendingCron detects stuck transactions
 * 2. GasPriceOracle fetches current optimal gas prices
 * 3. TransactionReplacer creates replacement transaction with higher gas
 * 4. EscrowResolverWalletClient signs and broadcasts replacement
 *
 * Note: Customer-initiated escrow deposits can only be speed-up by the
 * customer's own wallet. This service handles backend-initiated transactions.
 */

import {
  createPublicClient,
  http,
  type Hash,
  type TransactionRequest,
  parseGwei,
} from "viem";
import {
  getDb,
  processed_crypto_transactions,
  crypto_transaction_speedups,
  eq,
  and,
  sql,
  lt,
} from "@repo/database";
import { Logger } from "../logger";
import { getEscrowResolverWalletClient } from "../utils/wallet-provider";
import { getChainConfig, DEFAULT_CHAIN_ID } from "../config/web3-chains";

const logger = new Logger({ serviceName: "transaction-speedup" });

// ============================================================================
// CONFIGURATION
// ============================================================================

const SPEED_UP_CONFIG = {
  // Time after which a transaction is considered "stuck" (in minutes)
  stuckThresholdMinutes: 10,
  // Gas price increase percentage for replacement transactions
  gasBumpPercentage: 20,
  // Maximum gas price bump percentage (safety cap)
  maxGasBumpPercentage: 50,
  // Minimum gas price increase in Gwei (to ensure meaningful bump)
  minGasBumpGwei: 1,
  // Maximum number of speed-up attempts per transaction
  maxSpeedUpAttempts: 3,
} as const;

// ============================================================================
// TYPES
// ============================================================================

export interface SpeedUpResult {
  success: boolean;
  originalTxHash: Hash;
  replacementTxHash?: Hash;
  gasBumpPercentage: number;
  error?: string;
}

export interface GasPriceOracle {
  getGasPrice(): Promise<bigint>;
  getOptimisticGasPrice(): Promise<bigint>;
  getFastGasPrice(): Promise<bigint>;
}

// ============================================================================
// GAS PRICE ORACLE
// Fetches current gas prices from multiple sources
// ============================================================================

class GasPriceOracleService implements GasPriceOracle {
  private chainId: number;

  constructor(chainId: number = DEFAULT_CHAIN_ID) {
    this.chainId = chainId;
  }

  /**
   * Get current base gas price
   */
  async getGasPrice(): Promise<bigint> {
    const client = this.getPublicClient();
    return await client.getGasPrice();
  }

  /**
   * Get optimistic (standard) gas price for normal transactions
   */
  async getOptimisticGasPrice(): Promise<bigint> {
    const basePrice = await this.getGasPrice();
    // Add 10% buffer for faster inclusion
    return (basePrice * BigInt(110)) / BigInt(100);
  }

  /**
   * Get fast gas price for urgent transactions (replacement transactions)
   */
  async getFastGasPrice(): Promise<bigint> {
    const basePrice = await this.getGasPrice();
    // Add 20% buffer for fast inclusion
    return (basePrice * BigInt(120)) / BigInt(100);
  }

  /**
   * Get public client for current chain
   */
  private getPublicClient() {
    const chainConfig = getChainConfig(this.chainId);
    const rpcUrls = chainConfig.getServerRpcUrls();

    return createPublicClient({
      chain: chainConfig.chain,
      transport: http(rpcUrls[0]),
    });
  }
}

// ============================================================================
// TRANSACTION SPEED-UP SERVICE
// ============================================================================

export class TransactionSpeedUpService {
  private gasOracle: GasPriceOracle;
  private db: ReturnType<typeof getDb>;

  constructor(chainId: number = DEFAULT_CHAIN_ID) {
    this.gasOracle = new GasPriceOracleService(chainId);
    this.db = getDb();
  }

  /**
   * Check if a transaction is stuck (pending for too long)
   *
   * @param txHash - Transaction hash to check
   * @param thresholdMinutes - Override default stuck threshold
   * @returns true if transaction is stuck
   */
  async checkIfStuck(
    txHash: Hash,
    thresholdMinutes?: number,
  ): Promise<boolean> {
    const threshold = thresholdMinutes || SPEED_UP_CONFIG.stuckThresholdMinutes;
    const thresholdMs = threshold * 60 * 1000;

    try {
      // Check if transaction exists in processed_crypto_transactions table
      const existingTx =
        await this.db.query.processed_crypto_transactions.findFirst({
          where: eq(processed_crypto_transactions.txHash, txHash),
        });

      if (!existingTx) {
        // Transaction not in our system - can't determine if stuck
        return false;
      }

      // Check if transaction is old enough to be considered stuck
      const age = Date.now() - existingTx.createdAt.getTime();
      return age > thresholdMs;
    } catch (error: unknown) {
      logger.error({
        message: "Error checking if transaction is stuck",
        error: error instanceof Error ? error.message : String(error),
      });
      // Throw instead of returning false so the cron job knows it failed
      throw new Error(
        `Failed to verify transaction status: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Speed up a stuck transaction by re-submitting with higher gas
   *
   * @param params - Speed-up parameters
   * @returns Result of speed-up attempt
   */
  async speedUpTransaction(params: {
    originalTxHash: Hash;
    orderId?: string;
    reservationId?: string;
    entityId?: string;
  }): Promise<SpeedUpResult> {
    const { originalTxHash, orderId, reservationId, entityId } = params;
    const entityIdentifier = orderId || reservationId || entityId || "unknown";

    try {
      // Check if transaction is actually stuck
      const isStuck = await this.checkIfStuck(originalTxHash);
      if (!isStuck) {
        return {
          success: false,
          originalTxHash,
          gasBumpPercentage: 0,
          error: "Transaction is not stuck yet",
        };
      }

      // Get original transaction details
      const client = this.getPublicClient();
      const originalTx = await client.getTransaction({ hash: originalTxHash });

      if (!originalTx) {
        return {
          success: false,
          originalTxHash,
          gasBumpPercentage: 0,
          error: "Original transaction not found on-chain",
        };
      }

      // Check if original transaction was already confirmed
      const receipt = await client
        .getTransactionReceipt({ hash: originalTxHash })
        .catch(() => null);
      if (receipt) {
        return {
          success: false,
          originalTxHash,
          gasBumpPercentage: 0,
          error: "Original transaction already confirmed",
        };
      }

      // Calculate new gas price with bump
      const currentGasPrice = await this.gasOracle.getFastGasPrice();
      const originalGasPrice =
        originalTx.gasPrice || originalTx.maxFeePerGas || 0n;

      if (!originalGasPrice) {
        return {
          success: false,
          originalTxHash,
          gasBumpPercentage: 0,
          error: "Original transaction gas price not available",
        };
      }

      // Calculate gas bump (20% increase, capped at 50%)
      let gasBumpPercentage = SPEED_UP_CONFIG.gasBumpPercentage;
      let newGasPrice =
        (originalGasPrice * BigInt(100 + gasBumpPercentage)) / BigInt(100);

      // Ensure new gas price is at least current network gas price
      if (newGasPrice < currentGasPrice) {
        newGasPrice = currentGasPrice;
        gasBumpPercentage = Number(
          ((newGasPrice - originalGasPrice) * BigInt(100)) / originalGasPrice,
        );
      }

      // Ensure minimum gas bump (calculated BEFORE max cap to maintain proper ordering)
      const minGasBump =
        originalGasPrice + parseGwei(SPEED_UP_CONFIG.minGasBumpGwei.toString());
      if (newGasPrice < minGasBump) {
        newGasPrice = minGasBump;
        gasBumpPercentage = Number(
          ((newGasPrice - originalGasPrice) * BigInt(100)) / originalGasPrice,
        );
      }

      // Cap the gas bump (applied AFTER minGasBump to enforce hard ceiling)
      const maxGasPrice =
        (originalGasPrice *
          BigInt(100 + SPEED_UP_CONFIG.maxGasBumpPercentage)) /
        BigInt(100);
      if (newGasPrice > maxGasPrice) {
        newGasPrice = maxGasPrice;
        gasBumpPercentage = SPEED_UP_CONFIG.maxGasBumpPercentage;
      }

      logger.info({
        message: "Speeding up stuck transaction",
        txHash: originalTxHash.substring(0, 10),
        originalGasPrice: originalGasPrice.toString(),
        newGasPrice: newGasPrice.toString(),
        gasBumpPercentage,
      });

      // Create replacement transaction
      const replacementTx: TransactionRequest = {
        to: originalTx.to,
        from: originalTx.from,
        value: originalTx.value,
        data: originalTx.input,
        nonce: originalTx.nonce, // Same nonce for replacement
        gas: originalTx.gas,
        maxFeePerGas: newGasPrice,
        maxPriorityFeePerGas: newGasPrice / BigInt(2), // 50% of max fee as priority
      };

      // Get escrow resolver wallet client to broadcast replacement
      const walletClient = await this.getEscrowResolverWalletClient();

      if (!walletClient) {
        return {
          success: false,
          originalTxHash,
          gasBumpPercentage,
          error: "Escrow resolver wallet not available",
        };
      }

      // Send replacement transaction
      const replacementTxHash =
        await walletClient.sendTransaction(replacementTx);

      logger.info({
        message: "Replacement transaction sent",
        txHash: replacementTxHash.substring(0, 10),
        entityId: entityIdentifier,
      });

      // Update tracking in database
      await this.trackSpeedUpAttempt(
        originalTxHash,
        replacementTxHash,
        entityIdentifier,
        gasBumpPercentage,
      );

      return {
        success: true,
        originalTxHash,
        replacementTxHash,
        gasBumpPercentage,
      };
    } catch (error: unknown) {
      logger.error({
        message: "Failed to speed up transaction",
        txHash: originalTxHash,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        originalTxHash,
        gasBumpPercentage: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Track speed-up attempt in database
   */
  private async trackSpeedUpAttempt(
    originalTxHash: Hash,
    replacementTxHash: Hash,
    entityId: string,
    gasBumpPercentage: number,
  ): Promise<void> {
    try {
      // Insert or update speed-up tracking using Drizzle ORM upsert
      await this.db
        .insert(crypto_transaction_speedups)
        .values({
          originalTxHash,
          replacementTxHash,
          entityId,
          gasBumpPercentage,
          createdAt: new Date(),
        })
        .onConflictDoUpdate({
          target: crypto_transaction_speedups.originalTxHash,
          set: {
            replacementTxHash,
            gasBumpPercentage,
            updatedAt: new Date(),
          },
        });
    } catch (error: unknown) {
      logger.error({
        message: "Failed to track speed-up attempt",
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - tracking is best-effort
    }
  }

  /**
   * Get public client for blockchain interaction
   */
  private getPublicClient() {
    const chainConfig = getChainConfig(DEFAULT_CHAIN_ID);
    return createPublicClient({
      chain: chainConfig.chain,
      transport: http(chainConfig.getServerRpcUrls()[0]),
    });
  }

  /**
   * Get escrow resolver wallet client for signing transactions
   *
   * Note: In the non-custodial escrow model, this uses the escrow resolver key.
   * Speed-ups for customer-initiated escrow deposits may require the customer's
   * own wallet to rebroadcast. This client is primarily used for escrow contract
   * interactions that might need gas bumps (e.g., tip releases).
   */
  private async getEscrowResolverWalletClient() {
    try {
      // Use centralized wallet provider abstraction
      return await getEscrowResolverWalletClient(DEFAULT_CHAIN_ID);
    } catch (error: unknown) {
      logger.error({
        message: "Failed to get escrow resolver wallet client",
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

let defaultSpeedUpService: TransactionSpeedUpService | null = null;

/**
 * Get or create the default TransactionSpeedUpService instance
 */
export function getTransactionSpeedUpService(
  chainId?: number,
): TransactionSpeedUpService {
  if (!defaultSpeedUpService) {
    defaultSpeedUpService = new TransactionSpeedUpService(chainId);
  }
  return defaultSpeedUpService;
}

/**
 * Create a new TransactionSpeedUpService instance
 */
export function createTransactionSpeedUpService(
  chainId?: number,
): TransactionSpeedUpService {
  return new TransactionSpeedUpService(chainId);
}

// ============================================================================
// CRON JOB HELPER
// For use in verify-pending cron endpoint
// ============================================================================

/**
 * Process stuck transactions and speed them up
 *
 * Usage in cron job:
 * ```typescript
 * const result = await processStuckTransactions();
 * console.log(`Sped up ${result.speedUpCount} transactions`);
 * ```
 */
export async function processStuckTransactions(options?: {
  chainId?: number;
  maxTransactions?: number;
}): Promise<{
  speedUpCount: number;
  failedCount: number;
  totalProcessed: number;
}> {
  const speedUpService = createTransactionSpeedUpService(options?.chainId);
  const maxTransactions = options?.maxTransactions || 20;

  try {
    // Query transactions that are stuck (pending > threshold)
    const stuckThreshold = new Date(
      Date.now() - SPEED_UP_CONFIG.stuckThresholdMinutes * 60 * 1000,
    );

    const stuckTransactions = await getDb()
      .select({
        txHash: processed_crypto_transactions.txHash,
        entityId: processed_crypto_transactions.entityId,
        appSource: processed_crypto_transactions.appSource,
        createdAt: processed_crypto_transactions.createdAt,
      })
      .from(processed_crypto_transactions)
      .leftJoin(
        crypto_transaction_speedups,
        and(
          eq(
            processed_crypto_transactions.txHash,
            crypto_transaction_speedups.originalTxHash,
          ),
          sql`${crypto_transaction_speedups.createdAt} > NOW() - INTERVAL '1 hour'`,
        ),
      )
      .where(
        and(
          lt(processed_crypto_transactions.createdAt, stuckThreshold),
          sql`${crypto_transaction_speedups.originalTxHash} IS NULL`,
        ),
      )
      .limit(maxTransactions);

    if (stuckTransactions.length === 0) {
      return {
        speedUpCount: 0,
        failedCount: 0,
        totalProcessed: 0,
      };
    }

    logger.info({
      message: "Found stuck transactions to process",
      count: stuckTransactions.length,
    });

    let speedUpCount = 0;
    let failedCount = 0;

    for (const tx of stuckTransactions) {
      try {
        const result = await speedUpService.speedUpTransaction({
          originalTxHash: tx.txHash as Hash,
          entityId: tx.entityId,
        });

        if (result.success) {
          speedUpCount++;
        } else {
          failedCount++;
        }
      } catch (error: unknown) {
        logger.error({
          message: "Error processing stuck transaction",
          txHash: tx.txHash,
          error: error instanceof Error ? error.message : String(error),
        });
        failedCount++;
      }
    }

    return {
      speedUpCount,
      failedCount,
      totalProcessed: stuckTransactions.length,
    };
  } catch (error: unknown) {
    logger.error({
      message: "Critical error in processStuckTransactions",
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      speedUpCount: 0,
      failedCount: 0,
      totalProcessed: 0,
    };
  }
}
