import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as tablestackSchema from './schema/tablestack';

export const schema = {
  ...tablestackSchema,
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

const databaseUrl = process.env.DATABASE_URL!;

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

export const db = wrappedClient ? drizzle(wrappedClient as any, { schema }) : (null as any);

export type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
export { eq, and, gt, sql } from 'drizzle-orm';
export * from './schema/tablestack';
