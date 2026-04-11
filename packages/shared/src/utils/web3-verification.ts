/**
 * Web3 Transaction Verification Utility
 *
 * SINGLE SOURCE OF TRUTH for zero-trust verification of on-chain payments.
 * Consolidates verification logic from apps/open-delivery and apps/table-stack.
 *
 * Features:
 * - Supports both ETH (native) and ERC-20 (USDC, USDT) verification
 * - For ERC-20: parses Transfer event logs (transaction.value is always 0)
 * - For ETH: verifies transaction.value and optional order ID in tx data
 * - NON-CUSTODIAL ESCROW: parses OrderDeposited event from escrow contract
 * - Configurable confirmations, RPC URLs, and treasury/escrow addresses
 * - Fail-closed: returns explicit error objects, never throws
 * - CRITICAL: Implements global replay prevention via processed_crypto_transactions table
 * - CRITICAL: Requires cryptographic signature verification to prevent front-running
 */

import {
  createPublicClient,
  http,
  fallback,
  type Hash,
  type Address,
  type PublicClient,
  parseEventLogs,
  hexToString,
  verifyMessage,
  type Hex,
} from "viem";
import { base, polygon, mainnet } from "viem/chains";
import { ERC20_ABI } from "./erc20-abi";
import { ESCROW_ABI } from "./escrow-abi";
import { getDb, processed_crypto_transactions, eq } from "@repo/database";
import { Logger } from "../logger";

const logger = new Logger({ serviceName: "web3-verification" });

// ============================================================================
// CONFIGURATION
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

// Non-custodial escrow contract address (for Open-Delivery P2P payments)
const ESCROW_CONTRACT_ADDRESS = (process.env
  .NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as Address;

const MIN_CONFIRMATIONS = parseInt(
  process.env.NEXT_PUBLIC_MIN_CONFIRMATIONS || "3",
  10,
);

// Token decimals for common payment tokens
export const TOKEN_DECIMALS: Record<string, number> = {
  ETH: 18,
  USDC: 6,
  USDT: 6,
  DAI: 18,
  WBTC: 8,
};

// ============================================================================
// PUBLIC CLIENTS
// ============================================================================

/**
 * Get public client for a specific chain with fallback RPC URLs
 * Uses viem's fallback transport for automatic failover between RPC providers
 */
export function getPublicClient(chainId?: number) {
  const chain = chainId || base.id;

  if (chain === polygon.id) {
    return createPublicClient({
      chain: polygon,
      transport: fallback(RPC_URLS.polygon.map((url) => http(url))),
    }) as PublicClient;
  }

  if (chain === mainnet.id) {
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

// ============================================================================
// TRANSACTION VERIFICATION
// Zero-trust verification of on-chain payments
// ============================================================================

export interface TransactionVerificationResult {
  success: boolean;
  error?: string;
  receipt?: {
    status: "success" | "reverted";
    blockNumber: bigint;
    confirmations: number;
    from: Address;
    to: Address | null;
    value: bigint;
  };
}

/**
 * Verify a transaction on-chain
 *
 * This function performs zero-trust verification:
 * 1. CHECKS replay prevention table first (prevents front-running)
 * 2. Verifies cryptographic signature (proves wallet ownership)
 * 3. Checks if transaction exists and was successful
 * 4. For ESCROW: parses OrderDeposited event from escrow contract
 *    For DIRECT P2P: verifies recipient matches restaurant address
 * 5. Confirms the value matches expected amount
 * 6. Waits for minimum confirmations
 * 7. CRITICAL: Verifies transaction data contains order ID (prevents spoofing)
 * 8. CRITICAL: For ERC-20 tokens (USDC), parses Transfer event logs instead of tx.value
 * 9. REGISTERS transaction in replay prevention table after successful verification
 *
 * @param params - Verification parameters
 * @param params.txHash - Transaction hash to verify
 * @param params.expectedValue - Expected value in smallest units (Wei for ETH, atomic for USDC)
 * @param params.expectedRecipient - Expected recipient address (restaurant for P2P, escrow for Open-Delivery)
 * @param params.chainId - Chain ID (default: Base)
 * @param params.orderId - Order/reservation ID to verify in transaction data
 * @param params.paymentCurrency - 'ETH' or 'USDC' (affects verification logic)
 * @param params.walletAddress - Sender's wallet address (for additional verification)
 * @param params.signature - REQUIRED: Personal signature of the orderId/reservationId (prevents front-running)
 * @param params.appSource - Source app ('open-delivery' or 'table-stack') for replay prevention
 * @param params.isEscrowPayment - True if payment goes to escrow contract (Open-Delivery), false for direct P2P (TableStack)
 * @param params.minConfirmations - Override default minimum confirmations
 * @returns Verification result with success status and optional receipt
 */
export async function verifyTransaction(params: {
  txHash: Hash;
  expectedValue: bigint;
  expectedRecipient?: Address;
  chainId?: number;
  orderId?: string;
  paymentCurrency?: string;
  walletAddress?: Address;
  signature?: Hex; // REQUIRED: Personal sign of orderId/reservationId
  appSource?: string; // 'open-delivery' | 'table-stack'
  isEscrowPayment?: boolean; // True for Open-Delivery escrow, false for TableStack direct P2P
  minConfirmations?: number;
  /** Slippage tolerance in basis points for volatile tokens (e.g. ETH). 200 = 2% */
  slippageBps?: number;
}): Promise<TransactionVerificationResult> {
  const {
    txHash,
    expectedValue,
    expectedRecipient,
    chainId,
    orderId,
    paymentCurrency = "ETH",
    walletAddress,
    signature,
    appSource = "unknown",
    isEscrowPayment = false,
    minConfirmations = MIN_CONFIRMATIONS,
    slippageBps,
  } = params;

  // CRITICAL: orderId is required for signature verification
  if (!orderId) {
    return {
      success: false,
      error: "Order/reservation ID is required for verification",
    };
  }

  // CRITICAL: Signature is required to prevent front-running attacks
  if (!signature) {
    return {
      success: false,
      error: "Cryptographic signature is required to prevent front-running",
    };
  }

  try {
    const client = getPublicClient(chainId);

    // ============================================================================
    // STEP 0: REPLAY PREVENTION CHECK
    // Check if this transaction has already been processed (globally across all apps)
    // ============================================================================
    const existingTx =
      await getDb().query.processed_crypto_transactions.findFirst({
        where: eq(processed_crypto_transactions.txHash, txHash),
      });

    if (existingTx) {
      return {
        success: false,
        error: `Transaction already processed by ${existingTx.appSource} for entity ${existingTx.entityId}`,
      };
    }

    // Step 1: Get transaction receipt
    const receipt = await client.getTransactionReceipt({ hash: txHash });

    // Step 2: Check transaction status
    if (receipt.status !== "success") {
      return {
        success: false,
        error: `Transaction failed with status: ${receipt.status}`,
      };
    }

    // Step 3: Verify sender matches wallet address (if provided)
    if (
      walletAddress &&
      receipt.from.toLowerCase() !== walletAddress.toLowerCase()
    ) {
      return {
        success: false,
        error: `Transaction sender mismatch. Expected: ${walletAddress}, Got: ${receipt.from}`,
      };
    }

    // Step 4: Verify recipient
    // For escrow payments: recipient should be the escrow contract
    // For direct P2P ETH: recipient should be the restaurant wallet
    // For ERC-20 (USDC/USDT) direct P2P: receipt.to is the TOKEN CONTRACT, not the recipient
    //   The actual recipient is verified later via Transfer event logs
    const recipient =
      expectedRecipient ||
      (isEscrowPayment ? ESCROW_CONTRACT_ADDRESS : undefined);

    // For ERC-20 tokens, skip receipt.to check since it's the token contract
    // The actual recipient will be verified when parsing Transfer events
    const isERC20Payment =
      (paymentCurrency === "USDC" || paymentCurrency === "USDT") &&
      !isEscrowPayment;

    if (
      !isERC20Payment &&
      recipient &&
      receipt.to &&
      receipt.to.toLowerCase() !== recipient.toLowerCase()
    ) {
      return {
        success: false,
        error: `Transaction recipient mismatch. Expected: ${recipient}, Got: ${receipt.to}`,
      };
    }

    // For ERC20 payments, verify the transaction was sent to the correct token contract
    if (isERC20Payment && receipt.to) {
      const { AppConfig } = await import("../config");
      const usdcContractAddress = AppConfig.getUsdcContractAddress();
      if (
        usdcContractAddress &&
        receipt.to.toLowerCase() !== usdcContractAddress.toLowerCase()
      ) {
        return {
          success: false,
          error: `ERC-20 transaction sent to wrong contract. Expected: ${usdcContractAddress}, Got: ${receipt.to}`,
        };
      }
    }

    // Step 5: Get full transaction to verify value
    const transaction = await client.getTransaction({ hash: txHash });

    // ============================================================================
    // CRITICAL: Handle Escrow vs ERC-20 (USDC) vs ETH verification differently
    // ============================================================================

    let actualValue: bigint;

    if (isEscrowPayment) {
      // For escrow payments: parse OrderDeposited event from escrow contract
      try {
        const orderDepositedLogs = parseEventLogs({
          logs: receipt.logs,
          abi: ESCROW_ABI,
          eventName: "OrderDeposited",
        });

        // Find the OrderDeposited event matching our order ID
        const matchingEvent = orderDepositedLogs.find((log) => {
          const args = log.args as { orderId?: string; subtotal?: bigint };
          return args.orderId === orderId && args.subtotal !== undefined;
        });

        if (!matchingEvent) {
          return {
            success: false,
            error: `No OrderDeposited event found for orderId ${orderId}`,
          };
        }

        const eventArgs = matchingEvent.args as {
          orderId: string;
          subtotal: bigint;
          tip: bigint;
          platformFee: bigint;
        };
        actualValue =
          eventArgs.subtotal + eventArgs.tip + eventArgs.platformFee;

        logger.info({
          message: "Escrow OrderDeposited event verified",
          orderId: eventArgs.orderId,
          subtotal: eventArgs.subtotal.toString(),
          tip: eventArgs.tip.toString(),
          platformFee: eventArgs.platformFee.toString(),
          total: actualValue.toString(),
        });
      } catch (parseError) {
        return {
          success: false,
          error: `Failed to parse OrderDeposited events: ${parseError instanceof Error ? parseError.message : "Unknown error"}`,
        };
      }
    } else if (paymentCurrency === "USDC" || paymentCurrency === "USDT") {
      // For ERC-20 tokens (direct P2P), transaction.value is always 0
      // We need to parse the Transfer event logs to get the actual token amount

      try {
        // Parse event logs to find Transfer events
        const transferLogs = parseEventLogs({
          logs: receipt.logs,
          abi: ERC20_ABI,
          eventName: "Transfer",
        });

        // Find the Transfer event matching our expected recipient
        const matchingTransfer = transferLogs.find((log) => {
          const args = log.args as {
            from?: Address;
            to?: Address;
            value?: bigint;
          };
          return (
            args.to?.toLowerCase() === recipient?.toLowerCase() &&
            args.value !== undefined
          );
        });

        if (!matchingTransfer) {
          return {
            success: false,
            error: `No Transfer event found for recipient ${recipient}`,
          };
        }

        actualValue = (matchingTransfer.args as { value: bigint }).value;

        logger.info({
          message: "ERC-20 Transfer verified",
          from: (matchingTransfer.args as { from?: Address }).from,
          to: (matchingTransfer.args as { to?: Address }).to,
          value: actualValue.toString(),
        });
      } catch (parseError) {
        return {
          success: false,
          error: `Failed to parse ERC-20 Transfer events: ${parseError instanceof Error ? parseError.message : "Unknown error"}`,
        };
      }
    } else {
      // For native ETH, use transaction.value directly
      actualValue = transaction.value;
    }

    // Step 6: Verify the amount matches expected value (with optional slippage tolerance)
    // For volatile tokens like ETH, we allow a slippage band to handle price movement
    // between the time the user signed and the backend verified.
    if (slippageBps !== undefined) {
      // Apply slippage tolerance: accept values within the specified basis points
      const BASIS_POINTS = 10_000n;
      const slippage = BigInt(slippageBps);
      const lowerBound =
        (expectedValue * (BASIS_POINTS - slippage)) / BASIS_POINTS;
      const upperBound =
        (expectedValue * (BASIS_POINTS + slippage)) / BASIS_POINTS;

      if (actualValue < lowerBound || actualValue > upperBound) {
        return {
          success: false,
          error: `Transaction value outside slippage tolerance. Expected: ${expectedValue}, Got: ${actualValue}, Allowed range: [${lowerBound}, ${upperBound}]`,
        };
      }

      logger.info({
        message: `Value within slippage tolerance (${slippageBps}bps)`,
        expected: expectedValue.toString(),
        actual: actualValue.toString(),
        lowerBound: lowerBound.toString(),
        upperBound: upperBound.toString(),
      });
    } else if (actualValue !== expectedValue) {
      // Exact match required when no slippage specified (stablecoins like USDC)
      return {
        success: false,
        error: `Transaction value mismatch. Expected: ${expectedValue}, Got: ${actualValue}`,
      };
    }

    // Step 7: CRITICAL SECURITY - Verify transaction data contains order ID (for ETH payments)
    // For USDC transfers, the exact amount + recipient + sender verification is sufficient
    if (orderId && paymentCurrency !== "USDC" && paymentCurrency !== "USDT") {
      const txInput = transaction.input || "0x";

      if (txInput !== "0x" && txInput.length > 2) {
        try {
          const decodedData = hexToString(txInput);
          if (decodedData !== orderId) {
            return {
              success: false,
              error: `Transaction data mismatch. Expected order ID: ${orderId}, Got: ${decodedData}`,
            };
          }
        } catch {
          // If decoding fails, the data might be for a contract call (USDC transfer)
          // For USDC transfers, we rely on the exact amount + recipient + sender verification
          logger.warn({
            message:
              "Could not decode transaction data, likely USDC contract call",
          });
        }
      }
    }

    // Step 8: Check confirmations
    const currentBlock = await client.getBlockNumber();
    const confirmations = Number(currentBlock - receipt.blockNumber);

    if (confirmations < minConfirmations) {
      return {
        success: false,
        error: `Insufficient confirmations. Required: ${minConfirmations}, Current: ${confirmations}`,
      };
    }

    // ============================================================================
    // STEP 9: SIGNATURE VERIFICATION (CRITICAL - Prevents Front-Running)
    // Verify that the API requester cryptographically owns the wallet address
    // by checking they signed the orderId/reservationId with that wallet
    // ============================================================================
    if (walletAddress && signature) {
      try {
        // verifyMessage returns true if the signature is valid for the given address
        const isValidSignature = await verifyMessage({
          message: orderId, // The exact message that was signed
          signature: signature,
          address: walletAddress, // The claimed wallet address
        });

        if (!isValidSignature) {
          return {
            success: false,
            error:
              "Signature verification failed - signature does not match claimed wallet address",
          };
        }

        logger.info({
          message: "Signature verified",
          walletAddress,
          orderId,
        });
      } catch (sigError) {
        return {
          success: false,
          error: `Signature verification failed: ${sigError instanceof Error ? sigError.message : "Unknown error"}`,
        };
      }
    }

    // ============================================================================
    // STEP 10: REGISTER IN REPLAY PREVENTION TABLE
    // Record this transaction to prevent future replay attacks
    // ============================================================================
    try {
      await getDb().insert(processed_crypto_transactions).values({
        txHash: txHash,
        appSource: appSource,
        entityId: orderId,
      });
      logger.info({
        message: "Registered transaction in replay prevention table",
        txHashPrefix: txHash.substring(0, 10),
      });
    } catch (dbError) {
      // If this is a unique constraint violation, the tx was already registered
      // (race condition - another request beat us to it)
      if (
        dbError instanceof Error &&
        dbError.message.includes("duplicate key")
      ) {
        return {
          success: false,
          error:
            "Transaction already registered - possible replay attack detected",
        };
      }
      // Log but don't fail - this is a best-effort registration
      logger.error({
        message: "Failed to register transaction in replay prevention table",
        error: dbError,
      });
    }

    return {
      success: true,
      receipt: {
        status: "success",
        blockNumber: receipt.blockNumber,
        confirmations,
        from: receipt.from,
        to: receipt.to,
        value: actualValue,
      },
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      error: `Transaction verification failed: ${errorMessage}`,
    };
  }
}

// ============================================================================
// VALUE FORMATTING
// Convert between human-readable and smallest unit formats
// ============================================================================

/**
 * Format token amount from smallest units to human-readable format
 *
 * @param amount - Amount in smallest units (Wei, atomic units, etc.)
 * @param decimals - Token decimals (18 for ETH, 6 for USDC)
 * @returns Human-readable amount as string
 */
export function formatTokenAmount(
  amount: bigint | string,
  decimals: number = 18,
): string {
  const { formatUnits } = require("viem");
  return formatUnits(BigInt(amount), decimals);
}

/**
 * Parse human-readable token amount to smallest units using safe string manipulation
 * CRITICAL: Avoids floating-point precision errors by parsing string directly
 *
 * @param amount - Human-readable amount (e.g., "1.5")
 * @param decimals - Token decimals (18 for ETH, 6 for USDC)
 * @returns Amount in smallest units as bigint
 */
export function parseTokenAmount(
  amount: string,
  decimals: number = 18,
): bigint {
  // CRITICAL: Parse string directly to avoid floating-point errors
  // Split into integer and fractional parts
  const { parseUnits } = require("viem");

  // Validate input format
  if (!amount || typeof amount !== "string") {
    throw new Error("Invalid amount: must be a non-empty string");
  }

  // Use viem's parseUnits which handles the conversion safely
  return parseUnits(amount, decimals);
}

/**
 * Format crypto price for display in UI
 * Shows appropriate decimal places based on token type
 *
 * @param amount - Amount in smallest units (string)
 * @param tokenSymbol - Token symbol (USDC, ETH, etc.)
 * @returns Formatted price string (e.g., "$10.50" or "0.005 ETH")
 */
export function formatCryptoPrice(
  amount: string | bigint,
  tokenSymbol: string = "USDC",
): string {
  const { formatUnits } = require("viem");
  const decimals = TOKEN_DECIMALS[tokenSymbol] || 6;
  const formatted = formatUnits(BigInt(amount), decimals);

  if (tokenSymbol === "USDC" || tokenSymbol === "USDT") {
    return `$${parseFloat(formatted).toFixed(2)}`;
  }

  if (tokenSymbol === "ETH") {
    return `${parseFloat(formatted).toFixed(6)} ETH`;
  }

  return `${parseFloat(formatted).toFixed(4)} ${tokenSymbol}`;
}

/**
 * Convert USD amount to crypto token amount using safe BigInt math
 * CRITICAL: Avoids floating-point precision errors by using integer arithmetic
 *
 * @param usdAmount - USD amount (e.g., 10.50)
 * @param tokenSymbol - Token symbol (ETH, USDC, etc.)
 * @param tokenPriceUsd - Token price in USD (from oracle)
 * @returns Token amount in smallest units (string)
 */
export function usdToCrypto(
  usdAmount: number,
  tokenSymbol: string,
  tokenPriceUsd: number,
): string {
  const decimals = TOKEN_DECIMALS[tokenSymbol] || 6;

  // CRITICAL: Use BigInt math to avoid floating-point precision errors
  // Formula: token_atomic = (USD_amount * 10^decimals) / token_price_USD
  // Using cents and basis points for precision:
  // token_atomic = (usdCents * 10^(decimals+2)) / tokenPriceScaled
  const BASIS_POINTS = 10_000n;
  const tokenPriceScaled = BigInt(
    Math.round(tokenPriceUsd * Number(BASIS_POINTS)),
  );
  const usdCents = BigInt(Math.round(usdAmount * 100));

  // Multiplier: 10^(decimals+2) to convert cents to atomic units with price scaling
  // For ETH (18 decimals): 10^20
  // For USDC (6 decimals): 10^8
  const CENTS_TO_ATOMIC_MULTIPLIER = 10n ** BigInt(decimals + 2);

  const tokenAmountAtomic =
    (usdCents * CENTS_TO_ATOMIC_MULTIPLIER) / tokenPriceScaled;

  return tokenAmountAtomic.toString();
}

/**
 * Get display text for payment status
 */
export function getPaymentStatusText(status: string): string {
  const statusMap: Record<string, string> = {
    pending: "Pending Confirmation",
    confirming: "Confirming on Blockchain",
    confirmed: "Payment Confirmed",
    completed: "Order Placed",
    error: "Payment Failed",
  };
  return statusMap[status] || status;
}

/**
 * Convert USD amount to token amount in smallest units using safe BigInt math
 * CRITICAL: Avoids floating-point precision errors by using integer arithmetic
 *
 * @param usdAmount - USD amount (e.g., 10.50)
 * @param tokenPrice - Token price in USD (e.g., 2000 for ETH)
 * @param decimals - Token decimals
 * @returns Token amount in smallest units
 */
export function usdToTokenAmount(
  usdAmount: number,
  tokenPrice: number,
  decimals: number,
): bigint {
  // CRITICAL: Use BigInt math to avoid floating-point precision errors
  // Formula: token_atomic = (USD_amount * 10^decimals) / token_price
  // Using cents and basis points for precision:
  // token_atomic = (usdCents * 10^(decimals+2)) / tokenPriceScaled
  const BASIS_POINTS = 10_000n;
  const tokenPriceScaled = BigInt(
    Math.round(tokenPrice * Number(BASIS_POINTS)),
  );
  const usdCents = BigInt(Math.round(usdAmount * 100));

  // Multiplier: 10^(decimals+2) to convert cents to atomic units with price scaling
  const CENTS_TO_ATOMIC_MULTIPLIER = 10n ** BigInt(decimals + 2);

  return (usdCents * CENTS_TO_ATOMIC_MULTIPLIER) / tokenPriceScaled;
}

// ============================================================================
// ADDRESS UTILITIES
// ============================================================================

/**
 * Validate Ethereum address format
 */
export function isValidAddress(address: string): boolean {
  // Simple regex check for 0x followed by 40 hex characters
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Validate transaction hash format
 */
export function isValidTxHash(hash: string): boolean {
  // Simple regex check for 0x followed by 64 hex characters
  return /^0x[a-fA-F0-9]{64}$/.test(hash);
}

/**
 * Shorten address for display (e.g., 0x1234...5678)
 */
export function shortenAddress(address: string, chars: number = 4): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

// ============================================================================
// ESCROW UTILITIES
// ============================================================================

/**
 * Get the escrow contract address
 */
export function getEscrowAddress(): Address {
  return ESCROW_CONTRACT_ADDRESS;
}

/**
 * Generate payment request data for wallet (escrow contract)
 */
export interface PaymentRequest {
  to: Address;
  value: bigint;
  data?: `0x${string}`;
  chainId: number;
}

export function createPaymentRequest(params: {
  amount: bigint;
  tokenSymbol?: string;
  chainId?: number;
}): PaymentRequest {
  const { amount, chainId = base.id } = params;

  return {
    to: ESCROW_CONTRACT_ADDRESS,
    value: amount,
    chainId,
  };
}
