import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { restaurants, restaurantReservations, restaurantTables } from '@repo/database';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

/**
 * Drizzle-to-MCP Bridge
 * Automatically reflects Drizzle table definitions into Zod/JSON schemas
 * for use in MCP tools.
 */

// Generate Zod schemas from Drizzle
export const RestaurantSchema = createSelectSchema(restaurants);
export const ReservationSchema = createSelectSchema(restaurantReservations);
export const TableSchema = createSelectSchema(restaurantTables);

// Specialized schemas for tool inputs
export const CreateReservationDBSchema = createInsertSchema(restaurantReservations).omit({
  id: true,
  createdAt: true,
  verificationToken: true,
});

/**
 * Utility to get JSON Schema for a tool
 */
export function getToolSchema(schema: z.ZodType<any>) {
  return zodToJsonSchema(schema, "input");
}

/**
 * Automated source-of-truth mapping
 */
export const DB_REFLECTED_SCHEMAS = {
  restaurants: RestaurantSchema,
  reservations: ReservationSchema,
  tables: TableSchema,
  createReservation: CreateReservationDBSchema,
};
