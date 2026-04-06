/**
 * Global Replay Guard Middleware
 *
 * Purpose: Prevent replay attacks across all Web3-enabled services
 * 
 * Problem Solved: Cross-Service Replay Vulnerability
 * - Without a unified check, an attacker could use one transaction hash to "pay" for multiple services
 * - Example: Use the same txHash to pay for both a reservation (table-stack) and delivery (open-delivery)
 * 
 * Solution: Universal Replay Guard
 * - Single source of truth: processed_crypto_transactions table
 * - Check BEFORE any tool logic is initialized
 * - Works for both open-delivery and table-stack
 * - Returns explicit error with details about original processing
 *
 * Usage in API routes:
 * ```typescript
 * // At the start of your API route handler
 * const replayGuard = await checkReplayPrevention({
 *   txHash: '0x...',
 *   appSource: 'open-delivery', // or 'table-stack'
 * });
 * 
 * if (!replayGuard.allowed) {
 *   return NextResponse.json({ error: replayGuard.error }, { status: 409 });
 * }
 * 
 * // Continue with tool logic...
 * ```
 *
 * Usage in Tools/Middleware:
 * ```typescript
 * // Before executing any crypto-related tool
 * const guard = await createReplayGuardMiddleware();
 * const result = await guard.check(txHash, 'open-delivery');
 * 
 * if (!result.allowed) {
 *   throw new Error(`Transaction already processed: ${result.error}`);
 * }
 * ```
 *
 * @package @repo/shared
 */

import { getDb, processed_crypto_transactions, eq } from "@repo/database";
import type { Hash } from "viem";

// ============================================================================
// TYPES
// ============================================================================

export interface ReplayGuardCheck {
  /** Transaction hash to check */
  txHash: Hash;
  /** Source app making the check ('open-delivery' | 'table-stack') */
  appSource: string;
  /** Optional entity ID for additional context */
  entityId?: string;
}

export interface ReplayGuardResult {
  /** Whether the transaction is allowed to proceed */
  allowed: boolean;
  /** Error message if not allowed */
  error?: string;
  /** Details about the original processing if found */
  existingTransaction?: {
    txHash: string;
    appSource: string;
    entityId: string;
    createdAt: Date;
  };
}

export interface ReplayGuardMiddleware {
  /**
   * Atomically check if a transaction is allowed and register it (TOCTOU-safe)
   * This combines check + register into a single atomic operation
   */
  check(params: ReplayGuardCheck): Promise<ReplayGuardResult>;
}

// ============================================================================
// REPLAY GUARD MIDDLEWARE
// ============================================================================

export class ReplayGuardService implements ReplayGuardMiddleware {
  private db: ReturnType<typeof getDb>;

  constructor() {
    this.db = getDb();
  }

  /**
   * Check if a transaction has already been processed (globally across all apps)
   *
   * ATOMIC INSERT-FIRST PATTERN (TOCTOU-safe):
   * Instead of SELECT-then-INSERT (which has a race condition), we INSERT first.
   * If the insert fails due to a unique constraint violation, the tx was already
   * processed by a concurrent request - this is a replay attack attempt.
   *
   * This prevents an attacker from reusing a transaction hash to pay for multiple services
   * by eliminating the window between check and registration.
   *
   * @param params - Check parameters (entityId is REQUIRED for atomic registration)
   * @returns Result indicating if transaction is allowed to proceed
   */
  async check(params: ReplayGuardCheck): Promise<ReplayGuardResult> {
    const { txHash, appSource, entityId } = params;

    if (!entityId) {
      return {
        allowed: false,
        error: "entityId is required for atomic replay guard check",
      };
    }

    try {
      // ATOMIC INSERT: Try to register the transaction first
      // This eliminates the TOCTOU race condition
      await this.db
        .insert(processed_crypto_transactions)
        .values({
          txHash,
          appSource,
          entityId,
        });

      // Insert succeeded - transaction is now registered and allowed to proceed
      console.log(
        `[ReplayGuard] Atomically registered tx ${txHash.substring(0, 10)}... ` +
        `for ${appSource} entity ${entityId}`
      );

      return {
        allowed: true,
      };
    } catch (error) {
      // Check if this is a duplicate key error (replay attack attempt)
      const isDuplicateError = error instanceof Error && (
        error.message.includes('duplicate key') ||
        error.message.includes('unique constraint') ||
        error.message.includes('23505') // Postgres unique violation SQLSTATE
      );

      if (isDuplicateError) {
        // Transaction already exists - look it up to provide details
        try {
          const existingTx = await this.db.query.processed_crypto_transactions.findFirst({
            where: eq(processed_crypto_transactions.txHash, txHash),
          });

          return {
            allowed: false,
            error: `Transaction already processed by ${existingTx?.appSource ?? 'unknown'} for entity ${existingTx?.entityId ?? 'unknown'} on ${existingTx?.createdAt?.toISOString() ?? 'unknown'}`,
            existingTransaction: existingTx ? {
              txHash: existingTx.txHash,
              appSource: existingTx.appSource,
              entityId: existingTx.entityId,
              createdAt: existingTx.createdAt,
            } : undefined,
          };
        } catch (lookupError) {
          // Fallback if lookup fails - still block as replay
          return {
            allowed: false,
            error: `Transaction already processed (replay detected)`,
          };
        }
      }

      // Other database error - fail-closed to prevent potential replay
      console.error("[ReplayGuard] Database error during atomic replay check:", error);
      return {
        allowed: false,
        error: `Replay guard check failed: ${error instanceof Error ? error.message : "Unknown database error"}`,
      };
    }
  }

  /**
   * Bulk check multiple transactions (for batch operations)
   *
   * @param checks - Array of check parameters
   * @returns Array of results in same order as input
   */
  async checkBatch(checks: ReplayGuardCheck[]): Promise<ReplayGuardResult[]> {
    const results: ReplayGuardResult[] = [];

    for (const check of checks) {
      const result = await this.check(check);
      results.push(result);
    }

    return results;
  }
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

let defaultReplayGuard: ReplayGuardService | null = null;

/**
 * Get or create the default ReplayGuard instance
 *
 * @returns Singleton ReplayGuard instance
 */
export function getReplayGuard(): ReplayGuardService {
  if (!defaultReplayGuard) {
    defaultReplayGuard = new ReplayGuardService();
  }
  return defaultReplayGuard;
}

/**
 * Create a new ReplayGuard instance
 *
 * Useful for testing or when you need multiple instances
 *
 * @returns New ReplayGuard instance
 */
export function createReplayGuard(): ReplayGuardService {
  return new ReplayGuardService();
}

// ============================================================================
// MIDDLEWARE HELPER FUNCTIONS
// ============================================================================

/**
 * Create replay guard middleware for API routes
 *
 * Usage:
 * ```typescript
 * export async function POST(req: NextRequest) {
 *   const guard = await createReplayGuardMiddleware();
 *   
 *   // Check before processing
 *   const result = await guard.check({
 *     txHash: '0x...',
 *     appSource: 'open-delivery',
 *     entityId: orderId,
 *   });
 *   
 *   if (!result.allowed) {
 *     return NextResponse.json({ error: result.error }, { status: 409 });
 *   }
 *   
 *   // Continue with processing...
 * }
 * ```
 */
export async function createReplayGuardMiddleware(): Promise<ReplayGuardMiddleware> {
  return getReplayGuard();
}

/**
 * Quick check helper - returns true if transaction is allowed
 *
 * NOTE: This atomically registers the transaction if allowed.
 * Do NOT call registerTransaction after this - it's already done.
 *
 * Usage:
 * ```typescript
 * const allowed = await isReplayAllowed({
 *   txHash: '0x...',
 *   appSource: 'table-stack',
 *   entityId: orderId, // REQUIRED for atomic registration
 * });
 *
 * if (!allowed) {
 *   throw new Error('Transaction already processed');
 * }
 * // Continue processing - transaction is already registered
 * ```
 */
export async function isReplayAllowed(params: ReplayGuardCheck): Promise<boolean> {
  const guard = getReplayGuard();
  const result = await guard.check(params);
  return result.allowed;
}

// ============================================================================
// NEXT.JS MIDDLEWARE INTEGRATION (OPTIONAL)
// ============================================================================

/**
 * Next.js middleware wrapper for replay guard
 *
 * This can be used in apps/open-delivery/middleware.ts or apps/table-stack/middleware.ts
 * to automatically check replay prevention for specific routes.
 *
 * Example usage in middleware.ts:
 * ```typescript
 * import { NextResponse } from 'next/server';
 * import type { NextRequest } from 'next/server';
 * import { createReplayGuardForMiddleware } from '@repo/shared/middleware/web3-replay-guard';
 *
 * export async function middleware(request: NextRequest) {
 *   // Only check crypto payment routes
 *   if (request.nextUrl.pathname.startsWith('/api/checkout')) {
 *     const guard = await createReplayGuardForMiddleware();
 *     const txHash = request.headers.get('x-tx-hash');
 *     
 *     if (txHash) {
 *       const result = await guard.check({
 *         txHash: txHash as Hash,
 *         appSource: 'open-delivery',
 *       });
 *       
 *       if (!result.allowed) {
 *         return NextResponse.json(
 *           { error: result.error },
 *           { status: 409 }
 *         );
 *       }
 *     }
 *   }
 *   
 *   return NextResponse.next();
 * }
 * ```
 */
export async function createReplayGuardForMiddleware(): Promise<ReplayGuardMiddleware> {
  return getReplayGuard();
}
