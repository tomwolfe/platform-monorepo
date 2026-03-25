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

// Helper to safely create schema from Drizzle table
// Returns empty object schema if table is undefined or invalid
const safeCreateSelectSchema = (table: any, name: string) => {
  if (!table || typeof table !== 'object') {
    console.warn(`[Bridge] Table ${name} is not available, using empty schema`);
    return z.object({});
  }
  try {
    return createSelectSchema(table);
  } catch (error) {
    console.warn(`[Bridge] Failed to create select schema for ${name}:`, error);
    return z.object({});
  }
};

const safeCreateInsertSchema = (table: any, name: string, omitFields?: string[]) => {
  if (!table || typeof table !== 'object') {
    console.warn(`[Bridge] Table ${name} is not available, using empty schema`);
    return z.object({});
  }
  try {
    const schema = createInsertSchema(table);
    if (omitFields?.length) {
      return schema.omit(omitFields.reduce((acc, field) => ({ ...acc, [field]: true }), {}));
    }
    return schema;
  } catch (error) {
    console.warn(`[Bridge] Failed to create insert schema for ${name}:`, error);
    return z.object({});
  }
};

// Select schemas (for reading from DB)
export const RestaurantSchema = safeCreateSelectSchema(restaurants, 'restaurants');
export const ReservationSchema = safeCreateSelectSchema(restaurantReservations, 'restaurantReservations');
export const TableSchema = safeCreateSelectSchema(restaurantTables, 'restaurantTables');
export const WaitlistSchema = safeCreateSelectSchema(restaurantWaitlist, 'restaurantWaitlist');
export const RestaurantProductSchema = safeCreateSelectSchema(restaurantProducts, 'restaurantProducts');
export const InventoryLevelSchema = safeCreateSelectSchema(inventoryLevels, 'inventoryLevels');
export const GuestProfileSchema = safeCreateSelectSchema(guestProfiles, 'guestProfiles');

// Insert schemas (for creating new records)
export const CreateRestaurantSchema = safeCreateInsertSchema(restaurants, 'restaurants', ['id', 'createdAt', 'claimToken']);
export const CreateReservationDBSchema = safeCreateInsertSchema(restaurantReservations, 'restaurantReservations', ['id', 'createdAt', 'verificationToken']);
export const CreateTableSchema = safeCreateInsertSchema(restaurantTables, 'restaurantTables', ['id', 'updatedAt']);
export const AddToWaitlistDBSchema = safeCreateInsertSchema(restaurantWaitlist, 'restaurantWaitlist', ['id', 'createdAt', 'updatedAt']);
export const CreateRestaurantProductSchema = safeCreateInsertSchema(restaurantProducts, 'restaurantProducts', ['id', 'createdAt', 'updatedAt']);
export const CreateInventoryLevelSchema = safeCreateInsertSchema(inventoryLevels, 'inventoryLevels', ['id', 'updatedAt']);
export const CreateGuestProfileSchema = safeCreateInsertSchema(guestProfiles, 'guestProfiles', ['id', 'createdAt', 'updatedAt']);

// Update schemas (partial - all fields optional)
export const UpdateReservationDBSchema = safeCreateInsertSchema(restaurantReservations, 'restaurantReservations').partial().omit({ id: true, createdAt: true });
export const UpdateTableDBSchema = safeCreateInsertSchema(restaurantTables, 'restaurantTables').partial().omit({ id: true, restaurantId: true, updatedAt: true });
export const UpdateWaitlistDBSchema = safeCreateInsertSchema(restaurantWaitlist, 'restaurantWaitlist').partial().omit({ id: true, createdAt: true, updatedAt: true });

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
