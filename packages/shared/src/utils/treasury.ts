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
import { stringToHex, bytesToHex, hexToBytes } from 'viem';

// Dynamic import for Node.js crypto (only available in Node.js runtime)
let cryptoModule: typeof import('crypto') | null = null;

/**
 * Lazily load Node.js crypto module
 * Only called in Node.js runtime environments
 */
function getCryptoModule(): typeof import('crypto') {
  if (!cryptoModule) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cryptoModule = require('crypto');
  }
  return cryptoModule;
}

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

/**
 * Ethereum V3 Keystore Format
 * Based on https://github.com/ethereum/wiki/wiki/Web3-Secret-Storage-Definition
 */
interface V3Keystore {
  crypto: {
    cipher: string;
    cipherparams: {
      iv: string;
    };
    ciphertext: string;
    kdf: string;
    kdfparams: {
      dklen: number;
      n?: number; // scrypt
      r?: number; // scrypt
      p?: number; // scrypt
      salt: string;
      c?: number; // pbkdf2
      prf?: string; // pbkdf2
    };
    mac: string;
  };
  id: string;
  version: number;
}

/**
 * Decrypt Ethereum V3 keystore using scrypt KDF and AES-128-CTR
 * @param keystore - V3 keystore JSON
 * @param passphrase - Decryption passphrase
 * @returns Decrypted private key as hex string
 */
function decryptV3Keystore(keystore: V3Keystore, passphrase: string): `0x${string}` {
  const crypto = getCryptoModule();
  const { createDecipheriv } = crypto;
  
  const { crypto: cryptoData } = keystore;
  const ciphertext = hexToBytes(`0x${cryptoData.ciphertext}`);
  const iv = hexToBytes(`0x${cryptoData.cipherparams.iv}`);
  const kdfParams = cryptoData.kdfparams;
  const salt = hexToBytes(`0x${kdfParams.salt}`);

  // Derive key using scrypt
  let derivedKey: Buffer;
  if (cryptoData.kdf === 'scrypt') {
    derivedKey = scryptSync(
      passphrase,
      salt,
      kdfParams.dklen,
      {
        N: kdfParams.n!,
        r: kdfParams.r!,
        p: kdfParams.p!,
      }
    );
  } else if (cryptoData.kdf === 'pbkdf2') {
    derivedKey = pbkdf2Sync(
      passphrase,
      salt,
      kdfParams.c!,
      kdfParams.dklen,
      kdfParams.prf || 'sha256'
    );
  } else {
    throw new Error(`Unsupported KDF: ${cryptoData.kdf}`);
  }

  // Verify MAC
  const derivedKeyBuffer = Buffer.from(derivedKey);
  const macData = Buffer.concat([
    derivedKeyBuffer.subarray(16, 32),
    Buffer.from(ciphertext),
  ]);
  const mac = crypto.createHash('keccak256').update(macData).digest('hex');

  if (mac !== cryptoData.mac) {
    throw new Error('Invalid passphrase or corrupted keystore');
  }

  // Decrypt using AES-128-CTR
  const decipher = createDecipheriv(
    'aes-128-ctr',
    derivedKeyBuffer.subarray(0, 16),
    iv
  );
  decipher.setAutoPadding(false);

  const privateKeyBytes = Buffer.concat([
    decipher.update(Buffer.from(ciphertext)),
    decipher.final(),
  ]);

  return `0x${privateKeyBytes.toString('hex')}`;
}

/**
 * Synchronous scrypt key derivation
 */
function scryptSync(
  password: string,
  salt: Uint8Array,
  keylen: number,
  options: { N: number; r: number; p: number }
): Buffer {
  const crypto = getCryptoModule();
  return crypto.scryptSync(password, salt, keylen, options);
}

/**
 * Synchronous PBKDF2 key derivation
 */
function pbkdf2Sync(
  password: string,
  salt: Uint8Array,
  iterations: number,
  keylen: number,
  digest: string
): Buffer {
  const crypto = getCryptoModule();
  return crypto.pbkdf2Sync(password, salt, iterations, keylen, digest);
}

export class EncryptedKeystoreSigner implements ITreasurySigner {
  private account: Account;
  private address: Address;

  /**
   * Create signer from encrypted keystore
   * 
   * Accepts V3 keystore JSON and passphrase, decrypts the private key in memory,
   * and creates a viem Account for signing operations.
   * 
   * The private key exists only in memory and is never logged or exposed.
   * 
   * @param keystoreJson - V3 keystore JSON string
   * @param passphrase - Decryption passphrase
   * @throws Error if keystore is invalid or passphrase is incorrect
   */
  constructor(keystoreJson: string, passphrase: string) {
    try {
      const keystore: V3Keystore = JSON.parse(keystoreJson);
      
      if (keystore.version !== 3) {
        throw new Error(`Unsupported keystore version: ${keystore.version}. Expected V3.`);
      }

      // Decrypt the keystore to get the private key
      const privateKey = decryptV3Keystore(keystore, passphrase);
      
      // Create viem account from decrypted private key
      this.account = privateKeyToAccount(privateKey);
      this.address = this.account.address;
      
      // Clear sensitive data from memory (best effort in JS)
      Object.freeze(keystore);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Invalid passphrase')) {
        throw error;
      }
      throw new Error(
        `Failed to decrypt keystore: ${error instanceof Error ? error.message : String(error)}. ` +
        'Ensure TREASURY_KEYSTORE_JSON is valid V3 format and TREASURY_PASSPHRASE is correct.'
      );
    }
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
 * Priority:
 * 1. Encrypted Keystore (TREASURY_KEYSTORE_JSON + TREASURY_PASSPHRASE) - Recommended for production
 * 2. Raw Private Key (TREASURY_PRIVATE_KEY) - Development only, logs security warning
 *
 * @returns ITreasurySigner instance
 * @throws Error if no treasury configuration is found
 */
export function getTreasurySigner(): ITreasurySigner {
  const keystoreJson = process.env.TREASURY_KEYSTORE_JSON;
  const passphrase = process.env.TREASURY_PASSPHRASE;
  const privateKey = process.env.TREASURY_PRIVATE_KEY;

  // Priority 1: Use encrypted keystore (production-ready)
  if (keystoreJson && passphrase) {
    try {
      return new EncryptedKeystoreSigner(keystoreJson, passphrase);
    } catch (error) {
      throw new Error(
        `Failed to initialize EncryptedKeystoreSigner: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Priority 2: Fall back to raw private key (development only)
  if (privateKey) {
    console.warn(
      '⚠️  SECURITY WARNING: Using raw private key from environment variable. ' +
      'This is NOT recommended for production. ' +
      'Please use TREASURY_KEYSTORE_JSON and TREASURY_PASSPHRASE instead. ' +
      'See @repo/shared/utils/treasury for setup instructions.'
    );
    return new LocalEnvTreasurySigner(privateKey as `0x${string}`);
  }

  throw new Error(
    'No treasury configuration found. ' +
    'Set either: ' +
    '1) TREASURY_KEYSTORE_JSON and TREASURY_PASSPHRASE (recommended), or ' +
    '2) TREASURY_PRIVATE_KEY (development only, not secure for production)'
  );
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
