/**
 * Table Management Schemas for MCP Protocol
 * Based on TableStack database models (packages/database/src/schema/tablestack.ts)
 */

import { z } from "zod";

// ============================================================================
// TABLE MANAGEMENT - READ OPERATIONS
// ============================================================================

/**
 * GetTableAvailabilitySchema - Check table availability for a restaurant
 */
export const GetTableAvailabilitySchema = z.object({
  restaurantId: z.string().uuid().describe("The internal ID of the restaurant"),
  date: z.string().datetime().describe("ISO 8601 date/time for the reservation"),
  partySize: z.number().int().positive().describe("Number of guests"),
  durationMinutes: z.number().int().positive().optional().describe("Duration of the reservation in minutes (default: 90)"),
});

/**
 * GetTableLayoutSchema - Retrieve the table layout for a restaurant
 */
export const GetTableLayoutSchema = z.object({
  restaurantId: z.string().uuid().describe("The internal ID of the restaurant"),
  includeInactive: z.boolean().default(false).describe("Whether to include inactive tables"),
});

/**
 * GetReservationSchema - Retrieve a specific reservation
 */
export const GetReservationSchema = z.object({
  reservationId: z.string().uuid().describe("The unique identifier of the reservation"),
});

/**
 * ListReservationsSchema - List reservations for a restaurant
 */
export const ListReservationsSchema = z.object({
  restaurantId: z.string().uuid().describe("The internal ID of the restaurant"),
  startDate: z.string().datetime().optional().describe("Filter reservations from this date"),
  endDate: z.string().datetime().optional().describe("Filter reservations until this date"),
  status: z.enum(["confirmed", "cancelled", "noshow"]).optional().describe("Filter by reservation status"),
  limit: z.number().int().positive().max(100).default(20).describe("Maximum number of results"),
  offset: z.number().int().nonnegative().default(0).describe("Pagination offset"),
});

/**
 * CheckTableConflictsSchema - Check for conflicting reservations
 */
export const CheckTableConflictsSchema = z.object({
  restaurantId: z.string().uuid().describe("The internal ID of the restaurant"),
  tableId: z.string().uuid().describe("The ID of the table to check"),
  startTime: z.string().datetime().describe("Proposed reservation start time"),
  endTime: z.string().datetime().describe("Proposed reservation end time"),
  excludeReservationId: z.string().uuid().optional().describe("Exclude this reservation ID from conflict check (for updates)"),
});

// ============================================================================
// TABLE MANAGEMENT - WRITE OPERATIONS (REQUIRE CONFIRMATION)
// ============================================================================

/**
 * CreateReservationSchema - Create a new table reservation
 * REQUIRES CONFIRMATION
 */
export const CreateReservationSchema = z.object({
  restaurantId: z.string().uuid().describe("The internal ID of the restaurant"),
  tableId: z.string().uuid().describe("The ID of the table to reserve"),
  guestName: z.string().min(1).max(100).describe("Name for the reservation"),
  guestEmail: z.string().email().describe("Email for the reservation"),
  partySize: z.number().int().positive().max(100).describe("Number of guests"),
  startTime: z.string().datetime().describe("ISO 8601 start time for the reservation"),
  endTime: z.string().datetime().optional().describe("ISO 8601 end time (calculated if not provided)"),
  specialRequests: z.string().max(500).optional().describe("Any special requests"),
  combinedTableIds: z.array(z.string().uuid()).optional().describe("IDs of combined tables if using multiple tables"),
  depositAmount: z.number().int().nonnegative().optional().describe("Deposit amount in cents"),
  metadata: z.record(z.string(), z.unknown()).optional().describe("Additional metadata"),
});

/**
 * UpdateReservationSchema - Update an existing reservation
 * REQUIRES CONFIRMATION
 */
export const UpdateReservationSchema = z.object({
  reservationId: z.string().uuid().describe("The unique identifier of the reservation"),
  tableId: z.string().uuid().optional().describe("New table ID (if changing tables)"),
  guestName: z.string().min(1).max(100).optional().describe("Updated guest name"),
  guestEmail: z.string().email().optional().describe("Updated guest email"),
  partySize: z.number().int().positive().max(100).optional().describe("Updated party size"),
  startTime: z.string().datetime().optional().describe("Updated start time"),
  endTime: z.string().datetime().optional().describe("Updated end time"),
  status: z.enum(["confirmed", "cancelled", "noshow"]).optional().describe("Updated status"),
  specialRequests: z.string().max(500).optional().describe("Updated special requests"),
});

/**
 * CancelReservationSchema - Cancel a reservation
 * REQUIRES CONFIRMATION
 */
export const CancelReservationSchema = z.object({
  reservationId: z.string().uuid().describe("The unique identifier of the reservation"),
  reason: z.string().max(200).optional().describe("Reason for cancellation"),
  refundDeposit: z.boolean().default(true).describe("Whether to refund any deposit"),
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
  preferredTime: z.string().datetime().optional().describe("Preferred reservation time"),
});

/**
 * UpdateWaitlistStatusSchema - Update waitlist entry status
 */
export const UpdateWaitlistStatusSchema = z.object({
  waitlistId: z.string().uuid().describe("The unique identifier of the waitlist entry"),
  status: z.enum(["waiting", "notified", "seated"]).describe("New status"),
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
  startTime: z.string().datetime().describe("ISO 8601 start time for the reservation"),
  durationMinutes: z.number().int().positive().optional().describe("Duration of the reservation"),
});

/**
 * ReservationValidationResultSchema - Result of validation
 */
export const ReservationValidationResultSchema = z.object({
  valid: z.boolean().describe("Whether the reservation is valid"),
  conflicts: z.array(z.object({
    reservationId: z.string().uuid(),
    guestName: z.string(),
    startTime: z.string().datetime(),
    endTime: z.string().datetime(),
  })).optional().describe("Conflicting reservations if any"),
  warnings: z.array(z.string()).optional().describe("Validation warnings"),
  suggestedAlternatives: z.array(z.object({
    tableId: z.string().uuid(),
    tableNumber: z.string(),
    startTime: z.string().datetime(),
  })).optional().describe("Alternative options if validation fails"),
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
export type ReservationValidationResult = z.infer<typeof ReservationValidationResultSchema>;
