import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as tablestackSchema from './schema/tablestack';
import * as pgvectorSchema from './schema/pgvector';

export const schema = {
  ...tablestackSchema,
  ...pgvectorSchema,
};

// Re-export all schema items for convenience
export {
  users,
  restaurants,
  restaurantTables,
  restaurantReservations,
  restaurantWaitlist,
  restaurantProducts,
  inventoryLevels,
  guestProfiles,
  drivers,
  orders,
  orderItems,
  outbox,
  processed_crypto_transactions,
  crypto_transaction_speedups,
  // Enums
  waitlistStatusEnum,
  userRoleEnum,
  outboxStatusEnum,
  // Relations
  usersRelations,
  restaurantsRelations,
  restaurantTablesRelations,
  restaurantReservationsRelations,
  restaurantWaitlistRelations,
  restaurantProductsRelations,
  inventoryLevelsRelations,
  guestProfilesRelations,
  driversRelations,
  ordersRelations,
  orderItemsRelations,
} from './schema/tablestack';

// Re-export pgvector items (semanticMemories is defined here, not in tablestack)
export {
  semanticMemories,
  semanticMemoriesRelations,
  cosineSimilarity,
  innerProduct,
  l2Distance,
  l1Distance,
  VECTOR_DIMENSIONS,
  ENABLE_PGVECTOR_SQL,
  CREATE_SEMANTIC_MEMORIES_SQL,
  CREATE_RECENT_MEMORIES_VIEW_SQL,
  type VectorDimensionSize,
  type SemanticMemory,
  type NewSemanticMemory,
  type SemanticMemorySearchQuery,
  type SemanticMemorySearchResult,
} from './schema/pgvector';

const databaseUrl = process.env.DATABASE_URL;

// We avoid calling neon() if databaseUrl is missing, which can happen during build
// This allows the package to be imported during build time for type checking/metadata
const neonClient = databaseUrl ? neon(databaseUrl) : null;

// Lazy-initialized database instance
let _dbInstance: ReturnType<typeof drizzle> | null = null;

/**
 * Get the database instance with lazy initialization.
 * Throws a descriptive error at runtime if DATABASE_URL is not configured.
 *
 * This is the ONLY supported way to access the database. The db proxy export
 * has been removed to prevent type inference issues and masked connection failures.
 *
 * @example
 * ```typescript
 * import { getDb } from '@repo/database';
 *
 * const db = getDb();
 * const users = await db.select().from(users);
 * ```
 *
 * @throws Error if DATABASE_URL is not configured
 */
export function getDb() {
  if (_dbInstance) {
    return _dbInstance;
  }

  if (!neonClient) {
    throw new Error(
      'DATABASE_URL is not configured. ' +
      'Please set the DATABASE_URL environment variable to connect to the database.'
    );
  }

  _dbInstance = drizzle(neonClient, { schema });
  return _dbInstance;
}

export type { InferSelectModel, InferInsertModel } from 'drizzle-orm';

// Re-export sql directly
export { sql } from 'drizzle-orm';

// Import drizzle-orm comparison functions with aliases
import {
  eq as drizzleEq,
  lt as drizzleLt,
  gt as drizzleGt,
  gte as drizzleGte,
  lte as drizzleLte,
  desc as drizzleDesc,
  and as drizzleAnd,
  or as drizzleOr,
  ne as drizzleNe,
  isNull as drizzleIsNull,
  isNotNull as drizzleIsNotNull,
  inArray as drizzleInArray,
  notInArray as drizzleNotInArray,
  like as drizzleLike,
  notLike as drizzleNotLike,
  ilike as drizzleIlike,
  notIlike as drizzleNotIlike,
  exists as drizzleExists,
  notExists as drizzleNotExists,
  between as drizzleBetween,
  notBetween as drizzleNotBetween,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';

// Type-safe wrapper functions for drizzle-orm comparison operators
// These preserve type inference while providing a cleaner API
export const eq = <T>(col: SQLWrapper, value: T) => drizzleEq(col, value as any);
export const lt = <T>(col: SQLWrapper, value: T) => drizzleLt(col, value as any);
export const gt = <T>(col: SQLWrapper, value: T) => drizzleGt(col, value as any);
export const gte = <T>(col: SQLWrapper, value: T) => drizzleGte(col, value as any);
export const lte = <T>(col: SQLWrapper, value: T) => drizzleLte(col, value as any);
export const desc = <T>(col: SQLWrapper) => drizzleDesc(col);
export const and = (...conditions: Array<SQL | SQLWrapper | undefined | null | false>) => drizzleAnd(conditions as any);
export const or = (...conditions: Array<SQL | SQLWrapper | undefined | null | false>) => drizzleOr(conditions as any);
export const ne = <T>(col: SQLWrapper, value: T) => drizzleNe(col, value as any);
export const isNull = (col: SQLWrapper) => drizzleIsNull(col);
export const isNotNull = (col: SQLWrapper) => drizzleIsNotNull(col);
export const inArray = <T>(col: SQLWrapper, values: readonly T[] | SQLWrapper) => drizzleInArray(col, values as any);
export const notInArray = <T>(col: SQLWrapper, values: readonly T[] | SQLWrapper) => drizzleNotInArray(col, values as any);
export const like = (col: SQLWrapper, value: string) => drizzleLike(col, value);
export const notLike = (col: SQLWrapper, value: string) => drizzleNotLike(col, value);
export const ilike = (col: SQLWrapper, value: string) => drizzleIlike(col, value);
export const notIlike = (col: SQLWrapper, value: string) => drizzleNotIlike(col, value);
export const exists = (subquery: SQL) => drizzleExists(subquery);
export const notExists = (subquery: SQL) => drizzleNotExists(subquery);
export const between = <T>(col: SQLWrapper, min: T, max: T) => drizzleBetween(col, min as any, max as any);
export const notBetween = <T>(col: SQLWrapper, min: T, max: T) => drizzleNotBetween(col, min as any, max as any);

// ============================================================================
// WEB3 PAYMENT TYPES
// Type helpers for crypto payment handling with numeric precision
// ============================================================================

import type { InferSelectModel as DrizzleInferSelectModel } from 'drizzle-orm';
import { orders } from './schema/tablestack';

/**
 * CryptoAmount - String representation of token amounts in smallest units
 * - For ETH: Wei (18 decimals) - e.g., "1000000000000000000" = 1 ETH
 * - For USDC: Atomic units (6 decimals) - e.g., "1000000" = 1 USDC
 * 
 * Use viem's formatUnits() to convert to human-readable format
 * Use viem's parseUnits() to convert from human-readable format
 */
export type CryptoAmount = string;

/**
 * OrderWithCryptoPayment - Extended order type with Web3 payment fields
 */
export type OrderWithCryptoPayment = DrizzleInferSelectModel<typeof orders> & {
  paymentTxHash: string | null;
  walletAddress: string | null;
  paymentCurrency: string | null;
  subtotal: CryptoAmount;
  tip: CryptoAmount;
  total: CryptoAmount;
};
