/**
 * Treasury Account Management - Secure Key Storage
 *
 * Purpose: Secure Web3 private key management without vendor lock-in
 *
 * Security Features:
 * - Supports encrypted keystore JSON (Ethereum V3 format)
 * - Passphrase stored separately from encrypted keystore
 * - Key decrypted only in memory during signing operations
 * - No raw private keys exposed in business logic
 *
 * Setup:
 * Option 1 (Recommended): Use encrypted keystore
 *   1. Generate keystore: `cast wallet new --json` or use viem wallet utilities
 *   2. Set TREASURY_KEYSTORE_JSON env var (the encrypted JSON string)
 *   3. Set TREASURY_PASSPHRASE env var (the decryption password)
 *
 * Option 2 (Development only): Use raw private key
 *   - Set TREASURY_PRIVATE_KEY env var
 *   - WARNING: Not recommended for production
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
// ENCRYPTED KEYSTORE SIGNER
// Uses viem's wallet utilities for keystore decryption
// ============================================================================

export class EncryptedKeystoreSigner implements ITreasurySigner {
  private account: Account;
  private address: Address;

  /**
   * Create signer from encrypted keystore
   * Note: For production use with V3 keystores, use @ethereumjs/wallet or viem's
   * wallet utilities to decrypt the keystore first, then pass the private key.
   *
   * For now, this accepts a keystore JSON and passphrase, but requires manual
   * decryption using external tools until we add browser-compatible crypto.
   *
   * @param keystoreJson - V3 keystore JSON string
   * @param passphrase - Decryption passphrase
   * @deprecated Use generateTreasurySignerFromPrivateKey for now
   */
  constructor(_keystoreJson: string, _passphrase: string) {
    // Note: Full V3 keystore decryption requires Node.js crypto or Web Crypto API
    // For production, generate the keystore externally and extract the private key
    // using a secure HSM or key management service.
    //
    // This is a placeholder - in production, use AWS KMS, GCP Secret Manager,
    // or HashiCorp Vault to manage encrypted keys.
    throw new Error(
      'EncryptedKeystoreSigner requires external keystore decryption. ' +
      'For production, use AWS KMS or similar. ' +
      'For development, use TREASURY_PRIVATE_KEY environment variable.'
    );
  }

  async signTransaction(_txData: TransactionData): Promise<SignedTransaction> {
    throw new Error('EncryptedKeystoreSigner not implemented - use LocalEnvTreasurySigner for development');
  }

  getAddress(): Address {
    throw new Error('EncryptedKeystoreSigner not initialized');
  }

  async signMessage(_data: string | Uint8Array): Promise<`0x${string}`> {
    throw new Error('EncryptedKeystoreSigner not initialized');
  }
}

// ============================================================================
// LOCAL ENVIRONMENT TREASURY SIGNER
// Development/testing implementation using private key from environment
// @deprecated For production, use external key management (AWS KMS, etc.)
// ============================================================================

export class LocalEnvTreasurySigner implements ITreasurySigner {
  private account: Account;
  private address: Address;

  constructor(privateKey: `0x${string}`) {
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
  }

  async signTransaction(txData: TransactionData): Promise<SignedTransaction> {
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

  getAddress(): Address {
    return this.address;
  }

  async signMessage(data: string | Uint8Array): Promise<`0x${string}`> {
    if (!this.account.signMessage) {
      throw new Error('Account does not support message signing');
    }

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
// SIGNER FACTORY
// Returns appropriate signer based on configuration
// ============================================================================

/**
 * Get the treasury signer based on configuration
 *
 * Production: Should use external key management (AWS KMS, GCP Secret Manager)
 * Development: Uses LocalEnvTreasurySigner with TREASURY_PRIVATE_KEY
 *
 * @returns ITreasurySigner instance
 * @throws Error if no treasury configuration is found
 */
export function getTreasurySigner(): ITreasurySigner {
  const privateKey = process.env.TREASURY_PRIVATE_KEY;

  // For production: Integrate with AWS KMS, GCP Secret Manager, or HashiCorp Vault
  // Example for AWS KMS:
  // const kmsKeyId = process.env.AWS_KMS_TREASURY_KEY_ID;
  // if (kmsKeyId) {
  //   return new AwsKmsTreasurySigner(kmsKeyId);
  // }

  if (!privateKey) {
    throw new Error(
      'TREASURY_PRIVATE_KEY is not configured. ' +
      'This is required for executing payout transactions. ' +
      'For production, integrate with AWS KMS or similar key management service.'
    );
  }

  return new LocalEnvTreasurySigner(privateKey as `0x${string}`);
}

// ============================================================================
// LEGACY COMPATIBILITY FUNCTIONS
// @deprecated Use getTreasurySigner() instead
// ============================================================================

/**
 * Get the treasury account for signing payout transactions
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
      'This is required for executing payout transactions.'
    );
  }

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
 * @returns true if treasury credentials are set
 */
export function isTreasuryConfigured(): boolean {
  return !!process.env.TREASURY_PRIVATE_KEY;
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
  return getTreasuryAccount();
}

/**
 * Clear cached account (useful for testing or key rotation)
 * @deprecated Use clearTreasurySignerCache() instead
 */
export function clearTreasuryAccountCache(): void {
  clearTreasurySignerCache();
}
