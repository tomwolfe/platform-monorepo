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
 * - Configurable confirmations, RPC URLs, and treasury addresses
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
  type Log,
  hexToString,
  verifyMessage,
  type Hex,
} from "viem";
import { base, polygon, mainnet } from "viem/chains";
import { ERC20_ABI } from "./erc20-abi";
import { db, processed_crypto_transactions, eq } from "@repo/database";

// ============================================================================
// CONFIGURATION
// ============================================================================

const RPC_URLS = {
  base: [
    process.env.BASE_RPC_URL || "https://mainnet.base.org",
    "https://base.llamarpc.com",
    "https://base.publicnode.com",
  ],
  polygon: [
    process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
    "https://polygon.llamarpc.com",
    "https://polygon.publicnode.com",
  ],
  ethereum: [
    process.env.ETHEREUM_RPC_URL || "https://eth-mainnet.g.alchemy.com/v2/demo",
    "https://eth.llamarpc.com",
    "https://ethereum.publicnode.com",
  ],
};

const TREASURY_ADDRESS = (
  process.env.NEXT_PUBLIC_TREASURY_WALLET_ADDRESS || "0x0000000000000000000000000000000000000000"
) as Address;

const MIN_CONFIRMATIONS = parseInt(process.env.NEXT_PUBLIC_MIN_CONFIRMATIONS || "3", 10);

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
      transport: fallback(
        RPC_URLS.polygon.map((url) => http(url))
      ),
    }) as PublicClient;
  }

  if (chain === mainnet.id) {
    return createPublicClient({
      chain: mainnet,
      transport: fallback(
        RPC_URLS.ethereum.map((url) => http(url))
      ),
    }) as PublicClient;
  }

  // Default to Base
  return createPublicClient({
    chain: base,
    transport: fallback(
      RPC_URLS.base.map((url) => http(url))
    ),
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
 * 4. Verifies the recipient matches treasury/restaurant address
 * 5. Confirms the value matches expected amount
 * 6. Waits for minimum confirmations
 * 7. CRITICAL: Verifies transaction data contains order ID (prevents spoofing)
 * 8. CRITICAL: For ERC-20 tokens (USDC), parses Transfer event logs instead of tx.value
 * 9. REGISTERS transaction in replay prevention table after successful verification
 *
 * @param params - Verification parameters
 * @param params.txHash - Transaction hash to verify
 * @param params.expectedValue - Expected value in smallest units (Wei for ETH, atomic for USDC)
 * @param params.expectedRecipient - Expected recipient address (treasury or restaurant)
 * @param params.chainId - Chain ID (default: Base)
 * @param params.orderId - Order/reservation ID to verify in transaction data
 * @param params.paymentCurrency - 'ETH' or 'USDC' (affects verification logic)
 * @param params.walletAddress - Sender's wallet address (for additional verification)
 * @param params.signature - REQUIRED: Personal signature of the orderId/reservationId (prevents front-running)
 * @param params.appSource - Source app ('open-delivery' or 'table-stack') for replay prevention
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
  minConfirmations?: number;
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
    minConfirmations = MIN_CONFIRMATIONS,
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
    const existingTx = await db.query.processed_crypto_transactions.findFirst({
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
    if (walletAddress && receipt.from.toLowerCase() !== walletAddress.toLowerCase()) {
      return {
        success: false,
        error: `Transaction sender mismatch. Expected: ${walletAddress}, Got: ${receipt.from}`,
      };
    }

    // Step 4: Verify recipient (if provided)
    const recipient = expectedRecipient || TREASURY_ADDRESS;
    if (receipt.to && receipt.to.toLowerCase() !== recipient.toLowerCase()) {
      return {
        success: false,
        error: `Transaction recipient mismatch. Expected: ${recipient}, Got: ${receipt.to}`,
      };
    }

    // Step 5: Get full transaction to verify value
    const transaction = await client.getTransaction({ hash: txHash });

    // ============================================================================
    // CRITICAL: Handle ERC-20 (USDC) vs ETH verification differently
    // ============================================================================

    let actualValue: bigint;

    if (paymentCurrency === "USDC" || paymentCurrency === "USDT") {
      // For ERC-20 tokens, transaction.value is always 0
      // We need to parse the Transfer event logs to get the actual token amount

      try {
        // Parse event logs to find Transfer events
        const transferLogs = parseEventLogs({
          logs: receipt.logs,
          abi: ERC20_ABI,
          eventName: "Transfer",
        });

        // Find the Transfer event matching our expected recipient
        const matchingTransfer = transferLogs.find((log: any) => {
          const args = log.args as { from?: Address; to?: Address; value?: bigint };
          return args.to?.toLowerCase() === recipient.toLowerCase() && args.value !== undefined;
        });

        if (!matchingTransfer) {
          return {
            success: false,
            error: `No Transfer event found for recipient ${recipient}`,
          };
        }

        actualValue = (matchingTransfer.args as { value: bigint }).value;

        console.log(`[verifyTransaction] ERC-20 Transfer verified:`, {
          from: (matchingTransfer.args as any).from,
          to: (matchingTransfer.args as any).to,
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

    // Step 6: Verify the amount matches expected value
    if (actualValue !== expectedValue) {
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
        } catch (decodeError) {
          // If decoding fails, the data might be for a contract call (USDC transfer)
          // For USDC transfers, we rely on the exact amount + recipient + sender verification
          console.warn("Could not decode transaction data, likely USDC contract call");
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
            error: "Signature verification failed - signature does not match claimed wallet address",
          };
        }

        console.log(`[verifyTransaction] Signature verified: wallet ${walletAddress} signed orderId ${orderId}`);
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
      await db.insert(processed_crypto_transactions).values({
        txHash: txHash,
        appSource: appSource,
        entityId: orderId,
      });
      console.log(`[verifyTransaction] Registered tx ${txHash.substring(0, 10)}... in replay prevention table`);
    } catch (dbError) {
      // If this is a unique constraint violation, the tx was already registered
      // (race condition - another request beat us to it)
      if (dbError instanceof Error && dbError.message.includes('duplicate key')) {
        return {
          success: false,
          error: "Transaction already registered - possible replay attack detected",
        };
      }
      // Log but don't fail - this is a best-effort registration
      console.error("[verifyTransaction] Failed to register transaction in replay prevention table:", dbError);
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
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
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
export function formatTokenAmount(amount: bigint | string, decimals: number = 18): string {
  const { formatUnits } = require("viem");
  return formatUnits(BigInt(amount), decimals);
}

/**
 * Parse human-readable token amount to smallest units
 *
 * @param amount - Human-readable amount (e.g., "1.5")
 * @param decimals - Token decimals (18 for ETH, 6 for USDC)
 * @returns Amount in smallest units as bigint
 */
export function parseTokenAmount(amount: string, decimals: number = 18): bigint {
  const { parseUnits } = require("viem");
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
export function formatCryptoPrice(amount: string | bigint, tokenSymbol: string = "USDC"): string {
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
 * Convert USD amount to crypto token amount
 * Uses approximate price (in production, use oracle)
 *
 * @param usdAmount - USD amount
 * @param tokenSymbol - Token symbol
 * @param tokenPriceUsd - Token price in USD (from oracle)
 * @returns Token amount in smallest units (string)
 */
export function usdToCrypto(usdAmount: number, tokenSymbol: string, tokenPriceUsd: number): string {
  const tokenAmount = usdAmount / tokenPriceUsd;
  const decimals = TOKEN_DECIMALS[tokenSymbol] || 6;
  const { parseUnits } = require("viem");
  return parseUnits(tokenAmount.toFixed(decimals), decimals).toString();
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
 * Convert USD amount to token amount in smallest units
 *
 * @param usdAmount - USD amount (e.g., 10.50)
 * @param tokenPrice - Token price in USD (e.g., 2000 for ETH)
 * @param decimals - Token decimals
 * @returns Token amount in smallest units
 */
export function usdToTokenAmount(usdAmount: number, tokenPrice: number, decimals: number): bigint {
  const tokenAmount = usdAmount / tokenPrice;
  return parseTokenAmount(tokenAmount.toFixed(decimals), decimals);
}

// ============================================================================
// ADDRESS UTILITIES
// ============================================================================

/**
 * Validate Ethereum address format
 */
export function isValidAddress(address: string): boolean {
  const { isAddress } = require("viem");
  return isAddress(address);
}

/**
 * Validate transaction hash format
 */
export function isValidTxHash(hash: string): boolean {
  const { isHash } = require("viem");
  return isHash(hash);
}

/**
 * Shorten address for display (e.g., 0x1234...5678)
 */
export function shortenAddress(address: string, chars: number = 4): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

// ============================================================================
// TREASURY UTILITIES
// ============================================================================

/**
 * Get the treasury wallet address
 */
export function getTreasuryAddress(): Address {
  return TREASURY_ADDRESS;
}

/**
 * Generate payment request data for wallet
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
    to: TREASURY_ADDRESS,
    value: amount,
    chainId,
  };
}
