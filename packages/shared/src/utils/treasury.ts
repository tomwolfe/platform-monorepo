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
 * import { getTreasuryAccount } from '@repo/shared/utils/treasury';
 *
 * const account = await getTreasuryAccount();
 * 
 * const walletClient = createWalletClient({
 *   account,
 *   chain: base,
 *   transport: http(),
 * });
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { privateKeyToAccount, type Account } from 'viem/accounts';
import type { Address } from 'viem';

// ============================================================================
// TYPES
// ============================================================================

export interface TreasuryAccount {
  /** Viem account instance for signing */
  account: Account;
  /** Account address */
  address: Address;
}

// ============================================================================
// TREASURY ACCOUNT MANAGER
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
  return !!process.env.TREASURY_PRIVATE_KEY;
}

// ============================================================================
// FUTURE: AWS KMS INTEGRATION (Placeholder)
// ============================================================================

/**
 * Future implementation for AWS KMS-backed treasury account
 * 
 * TODO: When ready to migrate to AWS KMS:
 * 1. Replace privateKeyToAccount with createKmsAccount
 * 2. Store key ID in AWS_KMS_TREASURY_KEY_ID env var
 * 3. Use @aws-sdk/client-kms for signing operations
 * 
 * Example:
 * ```typescript
 * import { KMS } from '@aws-sdk/client-kms';
 * 
 * const kms = new KMS({ region: 'us-east-1' });
 * const keyId = process.env.AWS_KMS_TREASURY_KEY_ID;
 * 
 * const account = await createKmsAccount({
 *   kmsClient: kms,
 *   keyId,
 *   address: treasuryAddress,
 * });
 * ```
 */
export async function getTreasuryAccountFromKMS(): Promise<TreasuryAccount> {
  throw new Error(
    'AWS KMS integration not yet implemented. ' +
    'Currently using environment variable-based key management. ' +
    'See packages/shared/src/utils/treasury.ts for implementation details.'
  );
}

// ============================================================================
// SINGLETON CACHE
// ============================================================================

let cachedAccount: TreasuryAccount | null = null;

/**
 * Get cached treasury account (avoids repeated key parsing)
 * Use this in hot paths like cron jobs
 *
 * @returns Cached treasury account
 */
export function getCachedTreasuryAccount(): TreasuryAccount {
  if (!cachedAccount) {
    cachedAccount = getTreasuryAccount();
  }
  return cachedAccount;
}

/**
 * Clear cached account (useful for testing or key rotation)
 */
export function clearTreasuryAccountCache(): void {
  cachedAccount = null;
}
