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

// Select schemas (for reading from DB)
// Note: These are created at module load time and cached
// In test environments, tables may be undefined - we handle this gracefully
export const RestaurantSchema = restaurants ? createSelectSchema(restaurants) : z.object({});
export const ReservationSchema = restaurantReservations ? createSelectSchema(restaurantReservations) : z.object({});
export const TableSchema = restaurantTables ? createSelectSchema(restaurantTables) : z.object({});
export const WaitlistSchema = restaurantWaitlist ? createSelectSchema(restaurantWaitlist) : z.object({});
export const RestaurantProductSchema = restaurantProducts ? createSelectSchema(restaurantProducts) : z.object({});
export const InventoryLevelSchema = inventoryLevels ? createSelectSchema(inventoryLevels) : z.object({});
export const GuestProfileSchema = guestProfiles ? createSelectSchema(guestProfiles) : z.object({});

// Insert schemas (for creating new records)
// Guard against undefined tables in test environments
export const CreateRestaurantSchema = restaurants 
  ? createInsertSchema(restaurants).omit({ id: true, createdAt: true, claimToken: true })
  : z.object({});

export const CreateReservationDBSchema = restaurantReservations
  ? createInsertSchema(restaurantReservations).omit({ id: true, createdAt: true, verificationToken: true })
  : z.object({});

export const CreateTableSchema = restaurantTables
  ? createInsertSchema(restaurantTables).omit({ id: true, updatedAt: true })
  : z.object({});

export const AddToWaitlistDBSchema = restaurantWaitlist
  ? createInsertSchema(restaurantWaitlist).omit({ id: true, createdAt: true, updatedAt: true })
  : z.object({});

export const CreateRestaurantProductSchema = restaurantProducts
  ? createInsertSchema(restaurantProducts).omit({ id: true, createdAt: true, updatedAt: true })
  : z.object({});

export const CreateInventoryLevelSchema = inventoryLevels
  ? createInsertSchema(inventoryLevels).omit({ id: true, updatedAt: true })
  : z.object({});

export const CreateGuestProfileSchema = guestProfiles
  ? createInsertSchema(guestProfiles).omit({ id: true, createdAt: true, updatedAt: true })
  : z.object({});

// Update schemas (partial - all fields optional)
// Guard against undefined tables in test environments
export const UpdateReservationDBSchema = restaurantReservations
  ? createInsertSchema(restaurantReservations).partial().omit({ id: true, createdAt: true })
  : z.object({});

export const UpdateTableDBSchema = restaurantTables
  ? createInsertSchema(restaurantTables).partial().omit({ id: true, restaurantId: true, updatedAt: true })
  : z.object({});

export const UpdateWaitlistDBSchema = restaurantWaitlist
  ? createInsertSchema(restaurantWaitlist).partial().omit({ id: true, createdAt: true, updatedAt: true })
  : z.object({});

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
