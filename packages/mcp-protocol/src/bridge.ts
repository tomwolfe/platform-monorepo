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

/**
 * Helper to safely create select schema from Drizzle table
 * Returns empty object schema if table is undefined or invalid
 *
 * @param table - Drizzle table definition
 * @param name - Table name for logging
 * @returns Zod schema for selecting from the table
 */
function safeCreateSelectSchema(
  table: Record<string, unknown> | undefined,
  name: string
): z.ZodObject<z.ZodRawShape> {
  if (!table || typeof table !== 'object') {
    console.warn(`[Bridge] Table ${name} is not available, using empty schema`);
    return z.object({});
  }
  try {
    return createSelectSchema(table) as z.ZodObject<z.ZodRawShape>;
  } catch (error) {
    console.warn(`[Bridge] Failed to create select schema for ${name}:`, error);
    return z.object({});
  }
}

/**
 * Helper to safely create insert schema from Drizzle table
 * Returns empty object schema if table is undefined or invalid
 *
 * @param table - Drizzle table definition
 * @param name - Table name for logging
 * @param omitFields - Fields to omit from the schema
 * @returns Zod schema for inserting into the table
 */
function safeCreateInsertSchema(
  table: Record<string, unknown> | undefined,
  name: string,
  omitFields?: string[]
): z.ZodObject<z.ZodRawShape> {
  if (!table || typeof table !== 'object') {
    console.warn(`[Bridge] Table ${name} is not available, using empty schema`);
    return z.object({});
  }
  try {
    const schema = createInsertSchema(table);
    if (omitFields?.length) {
      return schema.omit(
        omitFields.reduce((acc, field) => ({ ...acc, [field]: true }), {} as Record<string, true>)
      ) as z.ZodObject<z.ZodRawShape>;
    }
    return schema as z.ZodObject<z.ZodRawShape>;
  } catch (error) {
    console.warn(`[Bridge] Failed to create insert schema for ${name}:`, error);
    return z.object({});
  }
}

// Select schemas (for reading from DB)
// Note: Type assertions used to work around drizzle-orm version compatibility issues
export const RestaurantSchema = safeCreateSelectSchema(restaurants as unknown as Record<string, unknown>, 'restaurants');
export const ReservationSchema = safeCreateSelectSchema(restaurantReservations as unknown as Record<string, unknown>, 'restaurantReservations');
export const TableSchema = safeCreateSelectSchema(restaurantTables as unknown as Record<string, unknown>, 'restaurantTables');
export const WaitlistSchema = safeCreateSelectSchema(restaurantWaitlist as unknown as Record<string, unknown>, 'restaurantWaitlist');
export const RestaurantProductSchema = safeCreateSelectSchema(restaurantProducts as unknown as Record<string, unknown>, 'restaurantProducts');
export const InventoryLevelSchema = safeCreateSelectSchema(inventoryLevels as unknown as Record<string, unknown>, 'inventoryLevels');
export const GuestProfileSchema = safeCreateSelectSchema(guestProfiles as unknown as Record<string, unknown>, 'guestProfiles');

// Insert schemas (for creating new records)
export const CreateRestaurantSchema = safeCreateInsertSchema(restaurants as unknown as Record<string, unknown>, 'restaurants', ['id', 'createdAt', 'claimToken']);
export const CreateReservationDBSchema = safeCreateInsertSchema(restaurantReservations as unknown as Record<string, unknown>, 'restaurantReservations', ['id', 'createdAt', 'verificationToken']);
export const CreateTableSchema = safeCreateInsertSchema(restaurantTables as unknown as Record<string, unknown>, 'restaurantTables', ['id', 'updatedAt']);
export const AddToWaitlistDBSchema = safeCreateInsertSchema(restaurantWaitlist as unknown as Record<string, unknown>, 'restaurantWaitlist', ['id', 'createdAt', 'updatedAt']);
export const CreateRestaurantProductSchema = safeCreateInsertSchema(restaurantProducts as unknown as Record<string, unknown>, 'restaurantProducts', ['id', 'createdAt', 'updatedAt']);
export const CreateInventoryLevelSchema = safeCreateInsertSchema(inventoryLevels as unknown as Record<string, unknown>, 'inventoryLevels', ['id', 'updatedAt']);
export const CreateGuestProfileSchema = safeCreateInsertSchema(guestProfiles as unknown as Record<string, unknown>, 'guestProfiles', ['id', 'createdAt', 'updatedAt']);

// Update schemas (partial - all fields optional)
export const UpdateReservationDBSchema = safeCreateInsertSchema(restaurantReservations as unknown as Record<string, unknown>, 'restaurantReservations').partial().omit({ id: true, createdAt: true });
export const UpdateTableDBSchema = safeCreateInsertSchema(restaurantTables as unknown as Record<string, unknown>, 'restaurantTables').partial().omit({ id: true, restaurantId: true, updatedAt: true });
export const UpdateWaitlistDBSchema = safeCreateInsertSchema(restaurantWaitlist as unknown as Record<string, unknown>, 'restaurantWaitlist').partial().omit({ id: true, createdAt: true, updatedAt: true });

/**
 * Utility to get JSON Schema for a tool
 */
export function getToolSchema<T extends z.ZodType>(schema: T) {
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
} as const;

/**
 * Get schema by table name for dynamic reflection
 */
export function getReflectedSchema<K extends keyof typeof DB_REFLECTED_SCHEMAS>(
  tableName: K
): (typeof DB_REFLECTED_SCHEMAS)[K] {
  return DB_REFLECTED_SCHEMAS[tableName];
}

/**
 * Helper to create MCP tool input schema from Drizzle table
 * Automatically handles field validation based on database constraints
 */
export function createMcpToolInputSchema<
  T extends z.ZodObject<z.ZodRawShape>,
>(
  baseSchema: T,
  options?: {
    omit?: (keyof z.infer<T>)[];
    partial?: boolean;
    required?: (keyof z.infer<T>)[];
  }
): z.ZodType<Partial<z.infer<T>>> {
  let schema: z.ZodType<Partial<z.infer<T>>> = baseSchema as unknown as z.ZodType<Partial<z.infer<T>>>;

  if (options?.omit) {
    schema = schema.omit(
      options.omit.reduce((acc, key) => {
        acc[key as string] = true;
        return acc;
      }, {} as Record<string, true>)
    ) as unknown as z.ZodType<Partial<z.infer<T>>>;
  }

  if (options?.partial) {
    schema = schema.partial() as unknown as z.ZodType<Partial<z.infer<T>>>;
  }

  if (options?.required) {
    schema = schema
      .partial()
      .required(
        options.required.reduce((acc, key) => {
          acc[key as string] = true;
          return acc;
        }, {} as Record<string, true>)
      ) as unknown as z.ZodType<Partial<z.infer<T>>>;
  }

  return schema;
}
