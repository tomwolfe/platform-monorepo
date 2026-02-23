import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import {
  restaurants,
  restaurantReservations,
  restaurantTables,
  restaurantWaitlist,
  restaurantProducts,
  inventoryLevels,
  guestProfiles,
} from '@repo/database';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

/**
 * Drizzle-to-MCP Bridge
 * Automatically reflects Drizzle table definitions into Zod/JSON schemas
 * for use in MCP tools.
 *
 * Unified Schema Authority: Adding a column to the database automatically
 * updates these Zod schemas, which then updates the LLM's understanding.
 */

// ============================================================================
// AUTO-GENERATED SCHEMAS FROM DRIZZLE
// ============================================================================

// Type assertion workaround for drizzle-zod type incompatibility
// See: https://github.com/drizzle-team/drizzle-orm/issues/2666
const asTable = <T extends Record<string, any>>(table: T) => table as any;

// Select schemas (for reading from DB)
export const RestaurantSchema = createSelectSchema(asTable(restaurants));
export const ReservationSchema = createSelectSchema(asTable(restaurantReservations));
export const TableSchema = createSelectSchema(asTable(restaurantTables));
export const WaitlistSchema = createSelectSchema(asTable(restaurantWaitlist));
export const RestaurantProductSchema = createSelectSchema(asTable(restaurantProducts));
export const InventoryLevelSchema = createSelectSchema(asTable(inventoryLevels));
export const GuestProfileSchema = createSelectSchema(asTable(guestProfiles));

// Insert schemas (for creating new records)
export const CreateRestaurantSchema = createInsertSchema(asTable(restaurants)).omit({
  id: true,
  createdAt: true,
  claimToken: true,
});

export const CreateReservationDBSchema = createInsertSchema(asTable(restaurantReservations)).omit({
  id: true,
  createdAt: true,
  verificationToken: true,
});

export const CreateTableSchema = createInsertSchema(asTable(restaurantTables)).omit({
  id: true,
  updatedAt: true,
});

export const AddToWaitlistDBSchema = createInsertSchema(asTable(restaurantWaitlist)).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const CreateRestaurantProductSchema = createInsertSchema(asTable(restaurantProducts)).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const CreateInventoryLevelSchema = createInsertSchema(asTable(inventoryLevels)).omit({
  id: true,
  updatedAt: true,
});

export const CreateGuestProfileSchema = createInsertSchema(asTable(guestProfiles)).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Update schemas (partial - all fields optional)
export const UpdateReservationDBSchema = createInsertSchema(asTable(restaurantReservations)).partial().omit({
  id: true,
  createdAt: true,
});

export const UpdateTableDBSchema = createInsertSchema(asTable(restaurantTables)).partial().omit({
  id: true,
  restaurantId: true,
  updatedAt: true,
});

export const UpdateWaitlistDBSchema = createInsertSchema(asTable(restaurantWaitlist)).partial().omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

/**
 * Utility to get JSON Schema for a tool
 */
export function getToolSchema(schema: z.ZodType<any>) {
  return zodToJsonSchema(schema, "input");
}

/**
 * Automated source-of-truth mapping
 * All tablestack tables are now reflected here automatically.
 */
export const DB_REFLECTED_SCHEMAS = {
  // Core entities
  restaurants: RestaurantSchema,
  reservations: ReservationSchema,
  tables: TableSchema,
  waitlist: WaitlistSchema,
  products: RestaurantProductSchema,
  inventory: InventoryLevelSchema,
  guests: GuestProfileSchema,

  // Create operations
  createRestaurant: CreateRestaurantSchema,
  createReservation: CreateReservationDBSchema,
  createTable: CreateTableSchema,
  addToWaitlist: AddToWaitlistDBSchema,
  createProduct: CreateRestaurantProductSchema,
  createInventory: CreateInventoryLevelSchema,
  createGuest: CreateGuestProfileSchema,

  // Update operations
  updateReservation: UpdateReservationDBSchema,
  updateTable: UpdateTableDBSchema,
  updateWaitlist: UpdateWaitlistDBSchema,
};

/**
 * Get schema by table name for dynamic reflection
 */
export function getReflectedSchema(tableName: keyof typeof DB_REFLECTED_SCHEMAS): z.ZodType<any> {
  return DB_REFLECTED_SCHEMAS[tableName];
}

/**
 * Helper to create MCP tool input schema from Drizzle table
 * Automatically handles field validation based on database constraints
 */
export function createMcpToolInputSchema<T extends z.ZodObject<any>>(
  baseSchema: T,
  options?: {
    omit?: (keyof z.infer<T>)[];
    partial?: boolean;
    required?: (keyof z.infer<T>)[];
  }
): z.ZodType<any> {
  let schema: any = baseSchema;

  if (options?.omit) {
    schema = schema.omit(options.omit.reduce((acc, key) => {
      acc[key as string] = true;
      return acc;
    }, {} as Record<string, true>));
  }

  if (options?.partial) {
    schema = schema.partial();
  }

  if (options?.required) {
    schema = schema.partial().required(options.required.reduce((acc, key) => {
      acc[key as string] = true;
      return acc;
    }, {} as Record<string, true>));
  }

  return schema;
}
