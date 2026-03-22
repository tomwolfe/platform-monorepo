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

// ============================================================================
// CORE DATABASE INTERFACE
// ============================================================================

export interface Database {
  // Query methods
  select: <T = any>() => SelectBuilder<T>;
  insert: <T = any>(table: any) => InsertBuilder<T>;
  update: <T = any>(table: any) => UpdateBuilder<T>;
  delete: <T = any>(table: any) => DeleteBuilder<T>;
  
  // Direct query execution
  execute: <T = any>(query: any) => Promise<{ rows: T[] }>;
  
  // Query helpers
  query: {
    [table: string]: {
      findFirst: (options?: { where?: any; orderBy?: any; limit?: number }) => Promise<any>;
      findMany: (options?: { where?: any; orderBy?: any; limit?: number }) => Promise<any[]>;
    };
  };
}

// ============================================================================
// QUERY BUILDER INTERFACES
// ============================================================================

export interface SelectBuilder<T> {
  from(table: any): SelectFromBuilder<T>;
}

export interface SelectFromBuilder<T> {
  where(condition: any): SelectWhereBuilder<T>;
  orderBy(...orders: any[]): SelectOrderByBuilder<T>;
  limit(count: number): SelectLimitBuilder<T>;
  leftJoin(table: any, condition: any): SelectJoinBuilder<T>;
  innerJoin(table: any, condition: any): SelectJoinBuilder<T>;
}

export interface SelectWhereBuilder<T> {
  orderBy(...orders: any[]): SelectOrderByBuilder<T>;
  limit(count: number): SelectLimitBuilder<T>;
}

export interface SelectOrderByBuilder<T> {
  limit(count: number): SelectLimitBuilder<T>;
}

export interface SelectLimitBuilder<T> {
  then(resolve: (value: T[]) => void, reject: (reason?: any) => void): PromiseLike<T[]>;
}

export interface SelectJoinBuilder<T> {
  where(condition: any): SelectWhereBuilder<T>;
}

export interface InsertBuilder<T> {
  values(data: any | any[]): InsertValuesBuilder<T>;
}

export interface InsertValuesBuilder<T> {
  returning(): InsertReturningBuilder<T>;
}

export interface InsertReturningBuilder<T> {
  then(resolve: (value: T[]) => void, reject: (reason?: any) => void): PromiseLike<T[]>;
}

export interface UpdateBuilder<T> {
  set(data: any): UpdateSetBuilder<T>;
}

export interface UpdateSetBuilder<T> {
  where(condition: any): UpdateWhereBuilder<T>;
}

export interface UpdateWhereBuilder<T> {
  returning(): UpdateReturningBuilder<T>;
  then(resolve: (value: { rowCount: number }) => void, reject: (reason?: any) => void): PromiseLike<{ rowCount: number }>;
}

export interface UpdateReturningBuilder<T> {
  then(resolve: (value: T[]) => void, reject: (reason?: any) => void): PromiseLike<T[]>;
}

export interface DeleteBuilder<T> {
  where(condition: any): DeleteWhereBuilder<T>;
}

export interface DeleteWhereBuilder<T> {
  returning(): DeleteReturningBuilder<T>;
  then(resolve: (value: { rowCount: number }) => void, reject: (reason?: any) => void): PromiseLike<{ rowCount: number }>;
}

export interface DeleteReturningBuilder<T> {
  then(resolve: (value: T[]) => void, reject: (reason?: any) => void): PromiseLike<T[]>;
}

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
