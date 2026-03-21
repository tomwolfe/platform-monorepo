/**
 * Web3 Utility Functions for Table-Stack
 *
 * Helper functions for crypto payment processing and verification
 */

import { createPublicClient, http, type Hash, type Address, parseEventLogs, type Log } from "viem";
import { base, polygon, mainnet } from "viem/chains";
import { ERC20_ABI } from "@repo/shared/utils/erc20-abi";

// ============================================================================
// CONFIGURATION
// ============================================================================

const RPC_URLS = {
  base: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  polygon: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
  ethereum: process.env.ETHEREUM_RPC_URL || "https://eth-mainnet.g.alchemy.com/v2/demo",
};

const MIN_CONFIRMATIONS = parseInt(process.env.NEXT_PUBLIC_MIN_CONFIRMATIONS || "1", 10);

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
 * Get public client for a specific chain
 */
export function getPublicClient(chainId?: number) {
  const chain = chainId || base.id;

  if (chain === polygon.id) {
    return createPublicClient({
      chain: polygon,
      transport: http(RPC_URLS.polygon),
    });
  }

  if (chain === mainnet.id) {
    return createPublicClient({
      chain: mainnet,
      transport: http(RPC_URLS.ethereum),
    });
  }

  // Default to Base
  return createPublicClient({
    chain: base,
    transport: http(RPC_URLS.base),
  });
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
 * CRITICAL FIX: Supports both ETH (native) and USDC (ERC-20) verification
 * - For ETH: checks transaction.value
 * - For USDC: parses Transfer event logs (transaction.value is always 0 for ERC-20)
 */
export async function verifyTransaction(params: {
  txHash: Hash;
  expectedValue: bigint;
  expectedRecipient?: Address;
  chainId?: number;
  paymentCurrency?: string; // 'ETH' or 'USDC' (affects verification logic)
}): Promise<TransactionVerificationResult> {
  const { txHash, expectedValue, expectedRecipient, chainId, paymentCurrency = 'ETH' } = params;

  try {
    const client = getPublicClient(chainId);

    // Step 1: Get transaction receipt
    const receipt = await client.getTransactionReceipt({ hash: txHash });

    // Step 2: Check transaction status
    if (receipt.status !== "success") {
      return {
        success: false,
        error: `Transaction failed with status: ${receipt.status}`,
      };
    }

    // Step 3: Verify recipient (if provided)
    const recipient = expectedRecipient;
    if (recipient && receipt.to && receipt.to.toLowerCase() !== recipient.toLowerCase()) {
      return {
        success: false,
        error: `Transaction recipient mismatch. Expected: ${recipient}, Got: ${receipt.to}`,
      };
    }

    // Step 4: Get full transaction to verify value
    const transaction = await client.getTransaction({ hash: txHash });

    // ============================================================================
    // CRITICAL FIX: Handle ERC-20 (USDC) vs ETH verification differently
    // ============================================================================
    
    let actualValue: bigint;
    
    if (paymentCurrency === 'USDC' || paymentCurrency === 'USDT') {
      // For ERC-20 tokens, transaction.value is always 0
      // We need to parse the Transfer event logs to get the actual token amount
      
      try {
        // Parse event logs to find Transfer events
        const transferLogs = parseEventLogs({
          logs: receipt.logs,
          abi: ERC20_ABI,
          eventName: 'Transfer',
        });
        
        // Find the Transfer event matching our expected recipient
        const matchingTransfer = transferLogs.find((log: any) => {
          const args = log.args as { from?: Address; to?: Address; value?: bigint };
          return (
            args.to?.toLowerCase() === recipient?.toLowerCase() &&
            args.value !== undefined
          );
        });
        
        if (!matchingTransfer) {
          return {
            success: false,
            error: `No Transfer event found for recipient ${recipient || 'unknown'}`,
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
          error: `Failed to parse ERC-20 Transfer events: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`,
        };
      }
    } else {
      // For native ETH, use transaction.value directly
      actualValue = transaction.value;
    }

    // Verify the amount matches expected value
    if (actualValue !== expectedValue) {
      return {
        success: false,
        error: `Transaction value mismatch. Expected: ${expectedValue}, Got: ${actualValue}`,
      };
    }

    // Step 5: Check confirmations
    const currentBlock = await client.getBlockNumber();
    const confirmations = Number(currentBlock - receipt.blockNumber);

    if (confirmations < MIN_CONFIRMATIONS) {
      return {
        success: false,
        error: `Insufficient confirmations. Required: ${MIN_CONFIRMATIONS}, Current: ${confirmations}`,
      };
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
// ============================================================================

/**
 * Format token amount from smallest units to human-readable format
 */
export function formatTokenAmount(amount: bigint | string, decimals: number = 18): string {
  const { formatUnits } = require("viem");
  return formatUnits(BigInt(amount), decimals);
}

/**
 * Parse human-readable token amount to smallest units
 */
export function parseTokenAmount(amount: string, decimals: number = 18): bigint {
  const { parseUnits } = require("viem");
  return parseUnits(amount, decimals);
}

/**
 * Format crypto price for display in UI
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
 * Get the treasury wallet address (optional, for fallback)
 */
export function getTreasuryAddress(): Address {
  return (process.env.NEXT_PUBLIC_TREASURY_WALLET_ADDRESS || "0x0000000000000000000000000000000000000000") as Address;
}
