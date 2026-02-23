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

// Workaround for Neon v1.x compatibility with older Drizzle versions
// Neon v1.x function only works as a tagged template unless .query() is used
const wrappedClient = neonClient ? ((...args: any[]) => {
  if (typeof args[0] === 'string') {
    return (neonClient as any).query(...args);
  }
  return (neonClient as any)(...args);
}) : null;

if (wrappedClient && neonClient) {
  Object.assign(wrappedClient, neonClient);
}

// FIX: Export a Proxy to prevent crashes when DATABASE_URL is missing during build
export const db = wrappedClient
  ? drizzle(wrappedClient as any, { schema })
  : new Proxy({} as any, {
      get(_, prop) {
        if (prop === 'then') return undefined;
        return () => {
          throw new Error(`Database operation failed: DATABASE_URL is not configured.`);
        };
      }
    });

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
} from 'drizzle-orm';

// Wrapper functions with type assertions to handle drizzle-orm type compatibility
export const eq = (col: any, value: any) => drizzleEq(col as any, value);
export const lt = (col: any, value: any) => drizzleLt(col as any, value);
export const gt = (col: any, value: any) => drizzleGt(col as any, value);
export const gte = (col: any, value: any) => drizzleGte(col as any, value);
export const lte = (col: any, value: any) => drizzleLte(col as any, value);
export const desc = (col: any) => drizzleDesc(col as any);
export const and = (...conditions: any[]) => drizzleAnd(...conditions as any);
export const or = (...conditions: any[]) => drizzleOr(...conditions as any);
export const ne = (col: any, value: any) => drizzleNe(col as any, value);
export const isNull = (col: any) => drizzleIsNull(col as any);
export const isNotNull = (col: any) => drizzleIsNotNull(col as any);
export const inArray = (col: any, values: any) => drizzleInArray(col as any, values as any);
export const notInArray = (col: any, values: any) => drizzleNotInArray(col as any, values as any);
export const like = (col: any, value: any) => drizzleLike(col as any, value as any);
export const notLike = (col: any, value: any) => drizzleNotLike(col as any, value as any);
export const ilike = (col: any, value: any) => drizzleIlike(col as any, value as any);
export const notIlike = (col: any, value: any) => drizzleNotIlike(col as any, value as any);
export const exists = (subquery: any) => drizzleExists(subquery as any);
export const notExists = (subquery: any) => drizzleNotExists(subquery as any);
export const between = (col: any, min: any, max: any) => drizzleBetween(col as any, min as any, max as any);
export const notBetween = (col: any, min: any, max: any) => drizzleNotBetween(col as any, min as any, max as any);

export * from './schema/tablestack';
