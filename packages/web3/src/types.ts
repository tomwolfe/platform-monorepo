/**
 * Web3 Type Definitions
 *
 * Re-exports viem types and defines custom domain types for
 * blockchain integration across the platform.
 *
 * @package @repo/web3
 */

// ============================================================================
// VIEM TYPE RE-EXPORTS
// ============================================================================

export type {
  Address,
  Hash,
  Hex,
  TransactionReceipt,
  Transaction,
  Log,
  Block,
  Account,
  Chain,
  HttpTransport,
  PublicClient,
  WalletClient,
  GetTransactionReceiptParameters,
  GetTransactionParameters,
  SendTransactionParameters,
  WaitForTransactionReceiptParameters,
  DecodeEventLogParameters,
  DecodeEventLogReturnType,
} from "viem";

import type { Address, Hash } from "viem";

// ============================================================================
// DOMAIN TYPES
// ============================================================================

/**
 * Escrow event data parsed from blockchain logs
 */
export interface EscrowEvent {
  orderId: string;
  driver: Address;
  tipAmount: bigint;
  eventName: string;
  blockNumber: bigint;
  transactionHash: Hash;
}

/**
 * Transaction verification result
 */
export interface TransactionVerificationResult {
  success: boolean;
  txHash?: Hash;
  blockNumber?: bigint;
  confirmations?: number;
  recipient?: Address;
  value?: bigint;
  error?: string;
}

/**
 * Web3 transaction parameters for checkout/payout flows
 */
export interface Web3TransactionParams {
  txHash: Hash;
  expectedValue: bigint;
  expectedRecipient: Address;
  paymentCurrency: string;
  orderId: string;
  isEscrowPayment: boolean;
  slippageBps?: number;
}

/**
 * Chain configuration with metadata
 */
export interface ChainMetadata {
  chainId: number;
  name: string;
  nativeCurrency: string;
  rpcUrls: string[];
  blockExplorerUrl?: string;
  escrowContractAddress?: Address;
}
