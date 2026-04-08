/**
 * Booking Tools - DEPRECATED
 *
 * The local mock booking tools (reserve_table, reserve_restaurant) have been removed.
 * The Intention Engine now relies EXCLUSIVELY on the dynamically discovered
 * TableStack MCP Server tools (bookTable, getAvailability).
 *
 * This file is kept as a placeholder to avoid breaking imports.
 * All booking functionality is provided via MCP discovery at runtime.
 */

// Re-export schemas that may still be used by registry
export { TableReservationSchema } from "@repo/mcp-protocol";

// Empty placeholder exports to satisfy any remaining imports
export const tableReservationReturnSchema = {} as const;
export type TableReservationParams = never;
export async function reserve_restaurant(): Promise<never> {
  throw new Error("Deprecated: Use MCP-discovered bookTable tool instead");
}
export async function reserve_table(): Promise<never> {
  throw new Error("Deprecated: Use MCP-discovered bookTable tool instead");
}
export const reserveRestaurantToolDefinition = {} as any;
export const reserveTableToolDefinition = {} as any;

