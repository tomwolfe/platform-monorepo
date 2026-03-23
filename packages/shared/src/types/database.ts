/**
 * Database Interfaces for Dependency Injection
 *
 * Purpose: Decouple @repo/shared from direct @repo/database imports
 * This allows @repo/shared to be used without creating circular dependencies
 *
 * Usage:
 * ```typescript
 * // In @repo/shared - accept interface via constructor
 * export class PGVectorStore {
 *   constructor(private db: Database) {}
 * }
 *
 * // In app - pass the actual db instance
 * const vectorStore = new PGVectorStore(db);
 * ```
 */

import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import type * as schema from '@repo/database';

// ============================================================================
// CORE DATABASE TYPE
// Properly typed Drizzle database instance without circular dependency
// ============================================================================

/**
 * Database instance type - Drizzle database with the full schema
 * This is the type returned by getDb() from @repo/database
 */
export type Database = NeonHttpDatabase<typeof schema>;

// ============================================================================
// TABLE SCHEMAS (Type-only exports for type safety)
// ============================================================================

export type { SemanticMemory, NewSemanticMemory } from '@repo/database';

// Re-export table references as type-only
import type { 
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
  semanticMemories,
} from '@repo/database';

export type UsersTable = typeof users;
export type RestaurantsTable = typeof restaurants;
export type RestaurantTablesTable = typeof restaurantTables;
export type RestaurantReservationsTable = typeof restaurantReservations;
export type RestaurantWaitlistTable = typeof restaurantWaitlist;
export type RestaurantProductsTable = typeof restaurantProducts;
export type InventoryLevelsTable = typeof inventoryLevels;
export type GuestProfilesTable = typeof guestProfiles;
export type DriversTable = typeof drivers;
export type OrdersTable = typeof orders;
export type OrderItemsTable = typeof orderItems;
export type OutboxTable = typeof outbox;
export type ProcessedCryptoTransactionsTable = typeof processed_crypto_transactions;
export type SemanticMemoriesTable = typeof semanticMemories;

// ============================================================================
// DRIZZLE ORM HELPERS (Type-only re-exports)
// ============================================================================

export type {
  SQL,
  InferSelectModel,
  InferInsertModel,
} from 'drizzle-orm';

// Re-export comparison functions as types
export {
  eq,
  lt,
  gt,
  gte,
  lte,
  desc,
  and,
  or,
  ne,
  isNull,
  isNotNull,
  inArray,
  notInArray,
  like,
  notLike,
  ilike,
  notIlike,
  exists,
  notExists,
  between,
  notBetween,
  sql,
} from 'drizzle-orm';
