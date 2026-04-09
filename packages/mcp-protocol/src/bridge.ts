import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import {
  restaurants,
  restaurantReservations,
  restaurantTables,
  restaurantWaitlist,
  restaurantProducts,
  inventoryLevels,
  guestProfiles,
} from "@repo/database";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";

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
  table: unknown,
  name: string,
): z.ZodObject<z.ZodRawShape> {
  if (!table) {
    console.warn(`[Bridge] Table ${name} is not available, using empty schema`);
    return z.object({});
  }
  try {
    // drizzle-zod's createSelectSchema accepts any table-like object.
    // We use an explicit cast here rather than a structural type definition
    // because drizzle-orm's PgTable has protected members that are incompatible
    // with structural typing. This is the safest escape hatch.
    return createSelectSchema(
      table as Parameters<typeof createSelectSchema>[0],
    ) as z.ZodObject<z.ZodRawShape>;
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
  table: unknown,
  name: string,
  omitFields?: string[],
): z.ZodObject<z.ZodRawShape> {
  if (!table) {
    console.warn(`[Bridge] Table ${name} is not available, using empty schema`);
    return z.object({});
  }
  try {
    const schema = createInsertSchema(
      table as Parameters<typeof createInsertSchema>[0],
    ) as z.ZodObject<z.ZodRawShape>;
    if (omitFields?.length) {
      const omitShape: Record<string, true> = {};
      for (const field of omitFields) {
        omitShape[field] = true;
      }
      return schema.omit(omitShape) as z.ZodObject<z.ZodRawShape>;
    }
    return schema;
  } catch (error) {
    console.warn(`[Bridge] Failed to create insert schema for ${name}:`, error);
    return z.object({});
  }
}

// Select schemas (for reading from DB)
export const RestaurantSchema = safeCreateSelectSchema(
  restaurants,
  "restaurants",
).extend({
  // CRITICAL FIX: drizzle-zod converts Postgres numeric columns to z.string(),
  // but the LLM provides actual numbers. Override to accept both.
  lat: z.coerce.number().optional().nullable(),
  lng: z.coerce.number().optional().nullable(),
});
export const ReservationSchema = safeCreateSelectSchema(
  restaurantReservations,
  "restaurantReservations",
);
export const TableSchema = safeCreateSelectSchema(
  restaurantTables,
  "restaurantTables",
);
export const WaitlistSchema = safeCreateSelectSchema(
  restaurantWaitlist,
  "restaurantWaitlist",
);
export const RestaurantProductSchema = safeCreateSelectSchema(
  restaurantProducts,
  "restaurantProducts",
);
export const InventoryLevelSchema = safeCreateSelectSchema(
  inventoryLevels,
  "inventoryLevels",
);
export const GuestProfileSchema = safeCreateSelectSchema(
  guestProfiles,
  "guestProfiles",
);

// Insert schemas (for creating new records)
export const CreateRestaurantSchema = safeCreateInsertSchema(
  restaurants,
  "restaurants",
  ["id", "createdAt", "claimToken"],
).extend({
  // CRITICAL FIX: drizzle-zod converts Postgres numeric columns to z.string(),
  // but the LLM provides actual numbers. Override to accept both.
  lat: z.coerce.number().optional().nullable(),
  lng: z.coerce.number().optional().nullable(),
});
export const CreateReservationDBSchema = safeCreateInsertSchema(
  restaurantReservations,
  "restaurantReservations",
  ["id", "createdAt", "verificationToken"],
);
export const CreateTableSchema = safeCreateInsertSchema(
  restaurantTables,
  "restaurantTables",
  ["id", "updatedAt"],
);
export const AddToWaitlistDBSchema = safeCreateInsertSchema(
  restaurantWaitlist,
  "restaurantWaitlist",
  ["id", "createdAt", "updatedAt"],
);
export const CreateRestaurantProductSchema = safeCreateInsertSchema(
  restaurantProducts,
  "restaurantProducts",
  ["id", "createdAt", "updatedAt"],
);
export const CreateInventoryLevelSchema = safeCreateInsertSchema(
  inventoryLevels,
  "inventoryLevels",
  ["id", "updatedAt"],
);
export const CreateGuestProfileSchema = safeCreateInsertSchema(
  guestProfiles,
  "guestProfiles",
  ["id", "createdAt", "updatedAt"],
);

// Update schemas (partial - all fields optional)
export const UpdateReservationDBSchema = safeCreateInsertSchema(
  restaurantReservations,
  "restaurantReservations",
)
  .partial()
  .omit({ id: true, createdAt: true });
export const UpdateTableDBSchema = safeCreateInsertSchema(
  restaurantTables,
  "restaurantTables",
)
  .partial()
  .omit({ id: true, restaurantId: true, updatedAt: true });
export const UpdateWaitlistDBSchema = safeCreateInsertSchema(
  restaurantWaitlist,
  "restaurantWaitlist",
)
  .partial()
  .omit({ id: true, createdAt: true, updatedAt: true });

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
  tableName: K,
): (typeof DB_REFLECTED_SCHEMAS)[K] {
  return DB_REFLECTED_SCHEMAS[tableName];
}

/**
 * Helper to create MCP tool input schema from Drizzle table
 * Automatically handles field validation based on database constraints
 */
export function createMcpToolInputSchema<T extends z.ZodObject<z.ZodRawShape>>(
  baseSchema: T,
  options?: {
    omit?: (keyof z.infer<T>)[];
    partial?: boolean;
    required?: (keyof z.infer<T>)[];
  },
): z.ZodType<Partial<z.infer<T>>> {
  // Start with the base schema cast to the target type
  let schema = baseSchema as unknown as z.ZodObject<z.ZodRawShape>;

  if (options?.omit) {
    const omitShape: Record<string, true> = {};
    for (const key of options.omit) {
      omitShape[key as string] = true;
    }
    schema = schema.omit(omitShape);
  }

  if (options?.partial) {
    schema = schema.partial();
  }

  if (options?.required) {
    const requiredShape: Record<string, true> = {};
    for (const key of options.required) {
      requiredShape[key as string] = true;
    }
    schema = schema.partial().required(requiredShape);
  }

  return schema as unknown as z.ZodType<Partial<z.infer<T>>>;
}
