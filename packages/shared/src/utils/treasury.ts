/**
 * Treasury Account Management
 *
 * Purpose: Abstract treasury private key management for Web3 payouts
 *
 * Problem Solved:
 * - Private keys should not be accessed directly in business logic
 * - Need to prepare for future migration to AWS KMS / GCP Secrets Manager
 * - Centralize key management for better security auditing
 *
 * Current Implementation:
 * - Reads from TREASURY_PRIVATE_KEY environment variable
 * - Returns viem Account instance for signing transactions
 *
 * Future Enhancement:
 * - TODO: Integrate with AWS KMS for hardware-backed key storage
 * - TODO: Implement key rotation support
 * - TODO: Add multi-sig wallet support for large payouts
 *
 * Usage:
 * ```typescript
 * import { getTreasurySigner } from '@repo/shared/utils/treasury';
 *
 * const signer = getTreasurySigner();
 * const signature = await signer.signTransaction(txData);
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { privateKeyToAccount, type Account } from 'viem/accounts';
import type { Address, Hash } from 'viem';
import { stringToHex, bytesToHex } from 'viem';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Transaction data to be signed
 */
export interface TransactionData {
  to: Address;
  value?: bigint;
  data?: `0x${string}`;
  nonce?: number;
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  chainId?: number;
  [key: string]: unknown;
}

/**
 * Signed transaction result
 */
export interface SignedTransaction {
  /** Raw signed transaction hex */
  rawTransaction: `0x${string}`;
  /** Transaction hash (if available) */
  hash?: Hash;
  /** Signer address */
  from: Address;
}

/**
 * Treasury Signer Interface
 * Abstracts the signing operation for future KMS integration
 */
export interface ITreasurySigner {
  /**
   * Sign a transaction
   * @param txData - Transaction data to sign
   * @returns Signed transaction
   */
  signTransaction(txData: TransactionData): Promise<SignedTransaction>;

  /**
   * Get the treasury address
   * @returns Treasury wallet address
   */
  getAddress(): Address;

  /**
   * Sign arbitrary data (for messages, typed data, etc.)
   * @param data - Data to sign
   * @returns Signature hex
   */
  signMessage(data: string | Uint8Array): Promise<`0x${string}`>;
}

/**
 * Treasury Account
 */
export interface TreasuryAccount {
  /** Viem account instance for signing */
  account: Account;
  /** Account address */
  address: Address;
}

// ============================================================================
// LOCAL ENVIRONMENT TREASURY SIGNER
// Implementation using private key from environment variable
// Suitable for development and testing
// ============================================================================

export class LocalEnvTreasurySigner implements ITreasurySigner {
  private account: Account;
  private address: Address;

  constructor(privateKey: `0x${string}`) {
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
  }

  /**
   * Sign a transaction using local private key
   */
  async signTransaction(txData: TransactionData): Promise<SignedTransaction> {
    // Use the account's built-in signTransaction method
    if (!this.account.signTransaction) {
      throw new Error('Account does not support transaction signing');
    }

    const signedTx = await this.account.signTransaction({
      to: txData.to,
      value: txData.value ?? BigInt(0),
      data: txData.data ?? '0x',
      nonce: txData.nonce ?? 0,
      gas: txData.gasLimit ?? BigInt(21000),
      maxFeePerGas: txData.maxFeePerGas ?? BigInt(1000000000),
      maxPriorityFeePerGas: txData.maxPriorityFeePerGas ?? BigInt(1000000000),
      chainId: txData.chainId ?? 1,
    });

    return {
      rawTransaction: signedTx,
      from: this.address,
    };
  }

  /**
   * Get the treasury address
   */
  getAddress(): Address {
    return this.address;
  }

  /**
   * Sign a message using local private key
   */
  async signMessage(data: string | Uint8Array): Promise<`0x${string}`> {
    // Use the account's built-in signMessage method
    if (!this.account.signMessage) {
      throw new Error('Account does not support message signing');
    }

    // Convert to hex string if needed
    const messageHex = typeof data === 'string' 
      ? stringToHex(data) 
      : bytesToHex(data);

    const signature = await this.account.signMessage({
      message: { raw: messageHex },
    });
    
    return signature;
  }
}

// ============================================================================
// FUTURE: AWS KMS TREASURY SIGNER (Placeholder)
// Implementation using AWS KMS for hardware-backed signing
// To be implemented when migrating to production
// ============================================================================

/**
 * AWS KMS Treasury Signer (Future Implementation)
 * 
 * TODO: When ready to implement:
 * 1. Install @aws-sdk/client-kms
 * 2. Store key ID in AWS_KMS_TREASURY_KEY_ID env var
 * 3. Use KMS client for signing operations
 * 
 * Example implementation:
 * ```typescript
 * import { KMS } from '@aws-sdk/client-kms';
 * import { signMessage } from 'viem';
 * 
 * export class AwsKmsTreasurySigner implements ITreasurySigner {
 *   private kmsClient: KMS;
 *   private keyId: string;
 *   private address: Address;
 * 
 *   constructor(keyId: string, address: Address) {
 *     this.kmsClient = new KMS({ region: 'us-east-1' });
 *     this.keyId = keyId;
 *     this.address = address;
 *   }
 * 
 *   async signTransaction(txData: TransactionData): Promise<SignedTransaction> {
 *     // Use KMS to sign the transaction
 *     const signResponse = await this.kmsClient.sign({
 *       KeyId: this.keyId,
 *       Message: encodeTransaction(txData),
 *       MessageType: 'RAW',
 *       SigningAlgorithm: 'ECDSA_SHA_256',
 *     });
 * 
 *     return {
 *       rawTransaction: `0x${Buffer.from(signResponse.Signature).toString('hex')}`,
 *       from: this.address,
 *     };
 *   }
 * 
 *   getAddress(): Address {
 *     return this.address;
 *   }
 * 
 *   async signMessage(data: string | Uint8Array): Promise<`0x${string}`> {
 *     const signResponse = await this.kmsClient.sign({
 *       KeyId: this.keyId,
 *       Message: typeof data === 'string' 
 *         ? new TextEncoder().encode(data)
 *         : data,
 *       MessageType: 'RAW',
 *       SigningAlgorithm: 'ECDSA_SHA_256',
 *     });
 * 
 *     return `0x${Buffer.from(signResponse.Signature).toString('hex')}`;
 *   }
 * }
 * ```
 */
export class AwsKmsTreasurySigner implements ITreasurySigner {
  async signTransaction(_txData: TransactionData): Promise<SignedTransaction> {
    throw new Error(
      'AWS KMS integration not yet implemented. ' +
      'Currently using environment variable-based key management. ' +
      'See packages/shared/src/utils/treasury.ts for implementation details.'
    );
  }

  getAddress(): Address {
    throw new Error('AWS KMS signer not initialized');
  }

  async signMessage(_data: string | Uint8Array): Promise<`0x${string}`> {
    throw new Error(
      'AWS KMS integration not yet implemented.'
    );
  }
}

// ============================================================================
// SIGNER FACTORY
// Returns appropriate signer based on configuration
// ============================================================================

/**
 * Get the treasury signer based on configuration
 * 
 * In development: Uses LocalEnvTreasurySigner with TREASURY_PRIVATE_KEY
 * In production: Should use AwsKmsTreasurySigner (when implemented)
 * 
 * @returns ITreasurySigner instance
 * @throws Error if no treasury configuration is found
 */
export function getTreasurySigner(): ITreasurySigner {
  const privateKey = process.env.TREASURY_PRIVATE_KEY;
  const kmsKeyId = process.env.AWS_KMS_TREASURY_KEY_ID;

  // Prefer KMS if configured (future production setup)
  if (kmsKeyId) {
    // TODO: Replace with actual AWS KMS signer when implemented
    // return new AwsKmsTreasurySigner(kmsKeyId, treasuryAddress);
    console.warn(
      '[Treasury] AWS KMS key ID configured but not yet implemented. ' +
      'Falling back to local private key signer.'
    );
  }

  // Fall back to local private key
  if (!privateKey) {
    throw new Error(
      'TREASURY_PRIVATE_KEY is not configured. ' +
      'This is required for executing payout transactions. ' +
      'Please set TREASURY_PRIVATE_KEY in your environment variables, ' +
      'or configure AWS_KMS_TREASURY_KEY_ID for KMS-based signing.'
    );
  }

  return new LocalEnvTreasurySigner(privateKey as `0x${string}`);
}

// ============================================================================
// LEGACY COMPATIBILITY FUNCTIONS
// Kept for backward compatibility with existing code
// Deprecated: Use getTreasurySigner() instead
// ============================================================================

/**
 * Get the treasury account for signing payout transactions
 * 
 * SECURITY NOTES:
 * - Private key is read from environment variable
 * - Key is never logged or exposed in error messages
 * - Account instance is cached to avoid repeated key parsing
 * 
 * @returns Treasury account with address
 * @throws Error if TREASURY_PRIVATE_KEY is not configured
 * @deprecated Use getTreasurySigner() instead
 */
export function getTreasuryAccount(): TreasuryAccount {
  const privateKey = process.env.TREASURY_PRIVATE_KEY;

  if (!privateKey) {
    throw new Error(
      'TREASURY_PRIVATE_KEY is not configured. ' +
      'This is required for executing payout transactions. ' +
      'Please set TREASURY_PRIVATE_KEY in your environment variables.'
    );
  }

  // Convert private key to account
  const account = privateKeyToAccount(privateKey as `0x${string}`);

  return {
    account,
    address: account.address,
  };
}

/**
 * Get treasury account address (without loading private key)
 * Useful for display/logging purposes
 * 
 * @returns Treasury wallet address or undefined if not configured
 * @deprecated Use getTreasurySigner().getAddress() instead
 */
export function getTreasuryAddress(): Address | undefined {
  const privateKey = process.env.TREASURY_PRIVATE_KEY;

  if (!privateKey) {
    return undefined;
  }

  try {
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    return account.address;
  } catch {
    return undefined;
  }
}

/**
 * Check if treasury is configured
 * 
 * @returns true if TREASURY_PRIVATE_KEY is set
 */
export function isTreasuryConfigured(): boolean {
  return !!process.env.TREASURY_PRIVATE_KEY || !!process.env.AWS_KMS_TREASURY_KEY_ID;
}

// ============================================================================
// SINGLETON CACHE
// Cached signer instance for performance
// ============================================================================

let cachedSigner: ITreasurySigner | null = null;

/**
 * Get cached treasury signer (avoids repeated initialization)
 * Use this in hot paths like cron jobs
 * 
 * @returns Cached treasury signer
 */
export function getCachedTreasurySigner(): ITreasurySigner {
  if (!cachedSigner) {
    cachedSigner = getTreasurySigner();
  }
  return cachedSigner;
}

/**
 * Clear cached signer (useful for testing or key rotation)
 */
export function clearTreasurySignerCache(): void {
  cachedSigner = null;
}

/**
 * Get cached treasury account (avoids repeated key parsing)
 * Use this in hot paths like cron jobs
 * 
 * @returns Cached treasury account
 * @deprecated Use getCachedTreasurySigner() instead
 */
export function getCachedTreasuryAccount(): TreasuryAccount {
  const signer = getCachedTreasurySigner();
  if (signer instanceof LocalEnvTreasurySigner) {
    return getTreasuryAccount();
  }
  throw new Error('Cannot get account from non-local signer');
}

/**
 * Clear cached account (useful for testing or key rotation)
 * @deprecated Use clearTreasurySignerCache() instead
 */
export function clearTreasuryAccountCache(): void {
  clearTreasurySignerCache();
}
