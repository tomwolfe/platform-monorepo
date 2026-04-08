/**
 * Table Management Schemas for MCP Protocol
 *
 * Unified Schema Authority: These schemas are derived from the Drizzle ORM
 * database definitions via the bridge layer. If the database schema changes,
 * these MCP tool schemas update automatically.
 *
 * Based on TableStack database models (packages/database/src/schema/tablestack.ts)
 */

import { z } from "zod";
import {
  CreateReservationDBSchema,
  UpdateReservationDBSchema,
  createMcpToolInputSchema,
  ReservationSchema,
  TableSchema,
  WaitlistSchema,
} from "../bridge";

// ============================================================================
// TABLE MANAGEMENT - READ OPERATIONS
// ============================================================================

/**
 * GetTableAvailabilitySchema - Check table availability for a restaurant
 */
export const GetTableAvailabilitySchema = z.object({
  restaurantId: z.string().uuid().describe("The internal ID of the restaurant"),
  date: z
    .string()
    .datetime()
    .describe("ISO 8601 date/time for the reservation"),
  partySize: z.number().int().positive().describe("Number of guests"),
  durationMinutes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Duration of the reservation in minutes (default: 90)"),
});

/**
 * GetTableLayoutSchema - Retrieve the table layout for a restaurant
 */
export const GetTableLayoutSchema = z.object({
  restaurantId: z.string().uuid().describe("The internal ID of the restaurant"),
  includeInactive: z
    .boolean()
    .default(false)
    .describe("Whether to include inactive tables"),
});

/**
 * GetReservationSchema - Retrieve a specific reservation
 * Derived from the auto-generated ReservationSchema (Drizzle select schema)
 */
export const GetReservationSchema = z.object({
  reservationId: z
    .string()
    .uuid()
    .describe("The unique identifier of the reservation"),
});

/**
 * ListReservationsSchema - List reservations for a restaurant
 */
export const ListReservationsSchema = z.object({
  restaurantId: z.string().uuid().describe("The internal ID of the restaurant"),
  startDate: z
    .string()
    .datetime()
    .optional()
    .describe("Filter reservations from this date"),
  endDate: z
    .string()
    .datetime()
    .optional()
    .describe("Filter reservations until this date"),
  status: z.string().optional().describe("Filter by reservation status"),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .default(20)
    .describe("Maximum number of results"),
  offset: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("Pagination offset"),
});

/**
 * CheckTableConflictsSchema - Check for conflicting reservations
 */
export const CheckTableConflictsSchema = z.object({
  restaurantId: z.string().uuid().describe("The internal ID of the restaurant"),
  tableId: z.string().uuid().describe("The ID of the table to check"),
  startTime: z.string().datetime().describe("Proposed reservation start time"),
  endTime: z.string().datetime().describe("Proposed reservation end time"),
  excludeReservationId: z
    .string()
    .uuid()
    .optional()
    .describe("Exclude this reservation ID from conflict check (for updates)"),
});

// ============================================================================
// TABLE MANAGEMENT - WRITE OPERATIONS (REQUIRE CONFIRMATION)
// ============================================================================

/**
 * CreateReservationSchema - Create a new table reservation
 * REQUIRES CONFIRMATION
 *
 * Derived from CreateReservationDBSchema (Drizzle insert schema) with
 * MCP-specific field descriptions and validation constraints.
 */
export const CreateReservationSchema = createMcpToolInputSchema(
  CreateReservationDBSchema,
  {
    required: [
      "restaurantId",
      "tableId",
      "guestName",
      "guestEmail",
      "partySize",
      "startTime",
    ],
  },
).extend({
  guestName: z.string().min(1).max(100).describe("Name for the reservation"),
  guestEmail: z.string().email().describe("Email for the reservation"),
  specialRequests: z
    .string()
    .max(500)
    .optional()
    .describe("Any special requests"),
  depositAmount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Deposit amount in cents"),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Additional metadata"),
});

/**
 * UpdateReservationSchema - Update an existing reservation
 * REQUIRES CONFIRMATION
 *
 * Derived from UpdateReservationDBSchema (Drizzle partial insert schema)
 */
export const UpdateReservationSchema = createMcpToolInputSchema(
  UpdateReservationDBSchema,
  {
    required: ["reservationId"],
  },
).extend({
  reservationId: z
    .string()
    .uuid()
    .describe("The unique identifier of the reservation"),
  guestName: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Updated guest name"),
  guestEmail: z.string().email().optional().describe("Updated guest email"),
  specialRequests: z
    .string()
    .max(500)
    .optional()
    .describe("Updated special requests"),
});

/**
 * CancelReservationSchema - Cancel a reservation
 * REQUIRES CONFIRMATION
 */
export const CancelReservationSchema = z.object({
  reservationId: z
    .string()
    .uuid()
    .describe("The unique identifier of the reservation"),
  reason: z.string().max(200).optional().describe("Reason for cancellation"),
  refundDeposit: z
    .boolean()
    .default(true)
    .describe("Whether to refund any deposit"),
});

// ============================================================================
// WAITLIST MANAGEMENT
// ============================================================================

/**
 * AddToWaitlistSchema - Add a party to the waitlist
 */
export const AddToWaitlistSchema = z.object({
  restaurantId: z.string().uuid().describe("The internal ID of the restaurant"),
  guestName: z.string().min(1).max(100).describe("Name of the guest"),
  guestEmail: z.string().email().describe("Email of the guest"),
  partySize: z.number().int().positive().max(100).describe("Number of guests"),
  preferredTime: z
    .string()
    .datetime()
    .optional()
    .describe("Preferred reservation time"),
});

/**
 * UpdateWaitlistStatusSchema - Update waitlist entry status
 * Uses the status enum from the auto-generated WaitlistSchema
 */
export const UpdateWaitlistStatusSchema = z.object({
  waitlistId: z
    .string()
    .uuid()
    .describe("The unique identifier of the waitlist entry"),
  status: (WaitlistSchema.shape?.status ?? z.string()).describe("New status"),
});

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

/**
 * ValidateReservationSchema - Validate a reservation without creating it (dry run)
 */
export const ValidateReservationSchema = z.object({
  restaurantId: z.string().uuid().describe("The internal ID of the restaurant"),
  tableId: z.string().uuid().describe("The ID of the table to validate"),
  guestEmail: z.string().email().describe("Email for the reservation"),
  partySize: z.number().int().positive().max(100).describe("Number of guests"),
  startTime: z
    .string()
    .datetime()
    .describe("ISO 8601 start time for the reservation"),
  durationMinutes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Duration of the reservation"),
});

/**
 * ReservationValidationResultSchema - Result of validation
 */
export const ReservationValidationResultSchema = z.object({
  valid: z.boolean().describe("Whether the reservation is valid"),
  conflicts: z
    .array(
      z.object({
        reservationId: z.string().uuid(),
        guestName: z.string(),
        startTime: z.string().datetime(),
        endTime: z.string().datetime(),
      }),
    )
    .optional()
    .describe("Conflicting reservations if any"),
  warnings: z.array(z.string()).optional().describe("Validation warnings"),
  suggestedAlternatives: z
    .array(
      z.object({
        tableId: z.string().uuid(),
        tableNumber: z.string(),
        startTime: z.string().datetime(),
      }),
    )
    .optional()
    .describe("Alternative options if validation fails"),
});

// ============================================================================
// TABLESTACK MCP SERVER SPECIFIC SCHEMAS
// These schemas are used by the table-stack MCP server implementation
// ============================================================================

/**
 * CheckAvailabilitySchema - TableStack MCP server tool
 * Note: Uses snake_case field names for consistency with MCP protocol
 */
export const CheckAvailabilitySchema = z.object({
  restaurantId: z.string().uuid().describe("The internal ID of the restaurant"),
  date: z
    .string()
    .datetime()
    .describe("ISO 8601 date/time for the reservation"),
  partySize: z.number().int().positive().describe("Number of guests"),
});

/**
 * BookTablestackReservationSchema - TableStack MCP server tool
 * Note: This is the MCP-specific version (different from create_reservation)
 */
export const BookTablestackReservationSchema = z.object({
  restaurantId: z.string().uuid().describe("The internal ID of the restaurant"),
  tableId: z
    .string()
    .uuid()
    .describe(
      "The ID of the table to book (can be combined like 'table1+table2')",
    ),
  guestName: z.string().min(1).max(100).describe("Name of the guest"),
  guestEmail: z.string().email().describe("Email address of the guest"),
  partySize: z.number().int().positive().max(100).describe("Number of guests"),
  startTime: z
    .string()
    .datetime()
    .describe("ISO 8601 date/time for the reservation"),
  is_confirmed: z
    .boolean()
    .optional()
    .describe("Whether the booking has been confirmed"),
});

/**
 * DiscoverRestaurantSchema - TableStack MCP server tool
 */
export const DiscoverRestaurantSchema = z.object({
  restaurant_slug: z
    .string()
    .describe("The slug/URL-friendly name of the restaurant"),
});

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type GetTableAvailability = z.infer<typeof GetTableAvailabilitySchema>;
export type GetTableLayout = z.infer<typeof GetTableLayoutSchema>;
export type GetReservation = z.infer<typeof GetReservationSchema>;
export type ListReservations = z.infer<typeof ListReservationsSchema>;
export type CheckTableConflicts = z.infer<typeof CheckTableConflictsSchema>;
export type CreateReservation = z.infer<typeof CreateReservationSchema>;
export type UpdateReservation = z.infer<typeof UpdateReservationSchema>;
export type CancelReservation = z.infer<typeof CancelReservationSchema>;
export type AddToWaitlist = z.infer<typeof AddToWaitlistSchema>;
export type UpdateWaitlistStatus = z.infer<typeof UpdateWaitlistStatusSchema>;
export type ValidateReservation = z.infer<typeof ValidateReservationSchema>;
export type ReservationValidationResult = z.infer<
  typeof ReservationValidationResultSchema
>;
// TableStack MCP server specific types
export type CheckAvailability = z.infer<typeof CheckAvailabilitySchema>;
export type BookTablestackReservation = z.infer<
  typeof BookTablestackReservationSchema
>;
export type DiscoverRestaurant = z.infer<typeof DiscoverRestaurantSchema>;
