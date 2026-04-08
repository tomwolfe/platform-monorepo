/**
 * API Validation Schemas
 *
 * Centralized Zod schemas for all API request/response validation.
 * Provides type-safe validation with detailed error messages.
 *
 * Usage:
 * ```typescript
 * import { ReserveRequestSchema, AvailabilityRequestSchema } from '@repo/shared';
 *
 * // In API route handler
 * const result = ReserveRequestSchema.safeParse(await req.json());
 * if (!result.success) {
 *   return NextResponse.json(formatValidationError(result.error), { status: 400 });
 * }
 * ```
 *
 * @see Phase 1.3: API Validation & Standardization
 */

import { z } from "zod";

// ============================================================================
// COMMON SCHEMAS
// ============================================================================

/**
 * UUID schema for IDs
 */
export const UUIDSchema = z.string().uuid("Invalid UUID format");

/**
 * Email schema with validation
 */
export const EmailSchema = z
  .string()
  .email("Invalid email format")
  .max(255, "Email must be less than 255 characters");

/**
 * Phone number schema (international format)
 */
export const PhoneSchema = z
  .string()
  .regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number format")
  .optional();

/**
 * ISO 8601 date-time schema
 */
export const DateTimeSchema = z
  .string()
  .refine(
    (val) => !isNaN(Date.parse(val)),
    "Invalid date-time format. Use ISO 8601 format (e.g., 2024-01-15T10:30:00Z)",
  );

/**
 * Positive integer schema
 */
export const PositiveIntSchema = z
  .number()
  .int("Must be an integer")
  .positive("Must be a positive number");

/**
 * Non-negative integer schema
 */
export const NonNegativeIntSchema = z
  .number()
  .int("Must be an integer")
  .nonnegative("Must be non-negative");

/**
 * Pagination schema
 */
export const PaginationSchema = z.object({
  page: NonNegativeIntSchema.optional().default(1),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

// ============================================================================
// RESERVATION SCHEMAS
// ============================================================================

/**
 * Reservation request schema
 */
export const ReserveRequestSchema = z.object({
  // Restaurant identification
  restaurantId: UUIDSchema.optional(),
  restaurantName: z.string().min(1).max(255).optional(),
  restaurantEmail: EmailSchema.optional(),

  // Table identification
  tableId: UUIDSchema.optional(),
  combinedTableIds: z.array(UUIDSchema).optional(),

  // Guest information
  guestName: z
    .string()
    .min(1)
    .max(255, "Guest name must be less than 255 characters"),
  guestEmail: EmailSchema,
  guestPhone: PhoneSchema,

  // Reservation details
  partySize: z
    .number()
    .int()
    .min(1)
    .max(50, "Party size must be between 1 and 50"),
  startTime: DateTimeSchema,
  duration: z.number().int().min(30).max(300).optional().default(90),

  // Special requests
  specialRequests: z.string().max(1000).optional(),
  occasion: z.enum(["birthday", "anniversary", "business", "other"]).optional(),

  // Metadata
  metadata: z.record(z.unknown()).optional(),

  // Idempotency - required for mutative operations
  // Note: This is validated from the x-idempotency-key header, not the request body
  idempotencyKey: z.string().max(128).optional(),
});

/**
 * Reservation response schema
 */
export const ReserveResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      message: z.string(),
      bookingId: UUIDSchema,
      verificationToken: z.string().optional(),
      verificationUrl: z.string().url().optional(),
    })
    .optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.unknown()).optional(),
    })
    .optional(),
  timestamp: DateTimeSchema,
  traceId: UUIDSchema.optional(),
});

/**
 * Reservation cancellation schema
 */
export const CancelReservationSchema = z.object({
  reservationId: UUIDSchema,
  reason: z.string().max(500).optional(),
  notifyGuest: z.boolean().optional().default(true),
});

// ============================================================================
// AVAILABILITY SCHEMAS
// ============================================================================

/**
 * Availability check request schema
 */
export const AvailabilityRequestSchema = z.object({
  restaurantId: UUIDSchema,
  date: DateTimeSchema,
  partySize: z.number().int().min(1).max(50),
  duration: z.number().int().min(30).max(300).optional().default(90),
});

/**
 * Table availability schema
 */
export const TableAvailabilitySchema = z.object({
  tableId: UUIDSchema,
  tableNumber: z.string(),
  minCapacity: z.number().int(),
  maxCapacity: z.number().int(),
  isCombined: z.boolean(),
  combinedTableIds: z.array(UUIDSchema).optional(),
});

/**
 * Availability response schema
 */
export const AvailabilityResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      restaurantId: UUIDSchema,
      requestedTime: DateTimeSchema,
      partySize: z.number().int(),
      availableTables: z.array(TableAvailabilitySchema),
      suggestedSlots: z
        .array(
          z.object({
            time: DateTimeSchema,
            availableTables: z.array(TableAvailabilitySchema),
          }),
        )
        .optional(),
    })
    .optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
  timestamp: DateTimeSchema,
});

// ============================================================================
// VERIFICATION SCHEMAS
// ============================================================================

/**
 * Reservation verification schema
 */
export const VerifyReservationSchema = z.object({
  token: z.string().min(1, "Verification token is required"),
});

/**
 * Verification response schema
 */
export const VerifyResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      message: z.string(),
      reservationId: UUIDSchema.optional(),
      status: z.enum(["confirmed", "cancelled", "expired"]),
    })
    .optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
  timestamp: DateTimeSchema,
});

// ============================================================================
// CHECKOUT / PAYMENT SCHEMAS
// ============================================================================

/**
 * Web3 checkout request schema
 *
 * Supports both orderId (for open-delivery) and reservationId (for table-stack)
 */
export const CheckoutRequestSchema = z
  .object({
    // Transaction details
    txHash: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid transaction hash format"),
    // Support both orderId and reservationId - at least one must be provided
    orderId: z.string().min(1, "Order ID is required").optional(),
    reservationId: z.string().uuid("Invalid reservation ID format").optional(),
    amount: z
      .string()
      .regex(/^\d+(\.\d+)?$/, "Invalid amount format")
      .optional(),
    currency: z.enum(["ETH", "USDC", "USDT", "DAI"]).optional(),

    // Chain information
    chainId: z.number().int().positive().optional().default(8453), // Base

    // Wallet information
    walletAddress: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid wallet address format")
      .optional(),
    signature: z
      .string()
      .regex(/^0x[a-fA-F0-9]+$/, "Invalid signature format")
      .optional(),

    // EIP-712 signature deadline (Unix timestamp in seconds)
    deadline: z.number().int().positive().optional(),

    // Payment metadata
    paymentCurrency: z.enum(["ETH", "USDC", "USDT", "DAI"]).optional(),
    minConfirmations: z.number().int().min(1).max(100).optional().default(3),
  })
  .refine((data) => data.orderId || data.reservationId, {
    message: "Either orderId or reservationId must be provided",
  });

/**
 * Checkout response schema
 */
export const CheckoutResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      message: z.string(),
      orderId: z.string(),
      paymentStatus: z.enum([
        "pending",
        "confirming",
        "confirmed",
        "completed",
        "failed",
      ]),
      txHash: z.string().optional(),
      confirmations: z.number().int().optional(),
      receipt: z
        .object({
          status: z.enum(["success", "reverted"]),
          blockNumber: z.string(),
          from: z.string(),
          to: z.string().nullable(),
          value: z.string(),
        })
        .optional(),
    })
    .optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.unknown()).optional(),
    })
    .optional(),
  timestamp: DateTimeSchema,
});

// ============================================================================
// RESTAURANT SCHEMAS
// ============================================================================

/**
 * Restaurant creation schema
 */
export const CreateRestaurantSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Slug must be lowercase alphanumeric with hyphens",
    ),
  ownerEmail: EmailSchema,
  ownerId: z.string().min(1),

  // Optional fields
  description: z.string().max(1000).optional(),
  address: z
    .object({
      street: z.string().max(255),
      city: z.string().max(255),
      state: z.string().max(255),
      zipCode: z.string().max(20),
      country: z.string().max(255),
    })
    .optional(),

  // Operating hours
  timezone: z.string().optional().default("UTC"),
  daysOpen: z.string().optional(),
  openingTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Use HH:MM format")
    .optional(),
  closingTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Use HH:MM format")
    .optional(),
  defaultDurationMinutes: z
    .number()
    .int()
    .min(30)
    .max(300)
    .optional()
    .default(90),
});

/**
 * Restaurant update schema (partial)
 */
export const UpdateRestaurantSchema = CreateRestaurantSchema.partial();

// ============================================================================
// WAITLIST SCHEMAS
// ============================================================================

/**
 * Join waitlist request schema
 */
export const JoinWaitlistSchema = z.object({
  restaurantId: UUIDSchema,
  guestName: z.string().min(1).max(255),
  guestEmail: EmailSchema,
  guestPhone: PhoneSchema,
  partySize: z.number().int().min(1).max(50),
  notes: z.string().max(500).optional(),
});

/**
 * Waitlist position response schema
 */
export const WaitlistPositionSchema = z.object({
  success: z.boolean(),
  data: z.object({
    position: z.number().int(),
    estimatedWaitTime: z.number().int(),
    partySize: z.number().int(),
    joinedAt: DateTimeSchema,
  }),
  timestamp: DateTimeSchema,
});

// ============================================================================
// DELIVERY SCHEMAS
// ============================================================================

/**
 * Delivery order request schema
 */
export const DeliveryOrderSchema = z.object({
  restaurantId: UUIDSchema,
  items: z
    .array(
      z.object({
        menuItemId: UUIDSchema,
        name: z.string(),
        quantity: z.number().int().min(1),
        price: z.number().nonnegative(),
        specialInstructions: z.string().max(500).optional(),
      }),
    )
    .min(1, "At least one item is required"),

  // Delivery address
  deliveryAddress: z.object({
    street: z.string().min(1),
    city: z.string().min(1),
    state: z.string().min(1),
    zipCode: z.string().min(1),
    instructions: z.string().max(500).optional(),
  }),

  // Contact information
  contactName: z.string().min(1),
  contactPhone: PhoneSchema,
  contactEmail: EmailSchema.optional(),

  // Payment
  paymentMethod: z.enum(["crypto", "card", "cash"]),
  paymentCurrency: z.enum(["ETH", "USDC", "USDT"]).optional(),

  // Timing
  scheduledTime: DateTimeSchema.optional(),
  asap: z.boolean().optional().default(true),
});

// ============================================================================
// ERROR RESPONSE SCHEMAS
// ============================================================================

/**
 * Validation error response schema
 */
export const ValidationErrorResponseSchema = z.object({
  success: z.boolean(),
  error: z.object({
    code: z.literal("VALIDATION_ERROR"),
    message: z.string(),
    details: z
      .array(
        z.object({
          field: z.string(),
          message: z.string(),
          code: z.string().optional(),
        }),
      )
      .optional(),
  }),
  timestamp: DateTimeSchema,
  traceId: UUIDSchema.optional(),
});

/**
 * API error response schema
 */
export const ApiErrorResponseSchema = z.object({
  success: z.boolean(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
  timestamp: DateTimeSchema,
  traceId: UUIDSchema.optional(),
});

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================

/**
 * Format Zod error into structured validation error
 */
export function formatValidationError(error: z.ZodError) {
  const details = error.errors.map((err) => ({
    field: err.path.join("."),
    message: err.message,
    code: err.code,
  }));

  return {
    success: false as const,
    error: {
      code: "VALIDATION_ERROR" as const,
      message: "Validation failed",
      details,
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Validate request with schema and return typed result
 */
export function validateRequest<T extends z.ZodType>(
  schema: T,
  data: unknown,
):
  | { success: true; data: z.infer<T> }
  | { success: false; error: ReturnType<typeof formatValidationError> } {
  const result = schema.safeParse(data);

  if (result.success) {
    return { success: true, data: result.data };
  }

  return { success: false, error: formatValidationError(result.error) };
}

/**
 * Create validation middleware for Next.js API routes
 */
export function createValidationMiddleware<T extends z.ZodType>(schema: T) {
  return async (req: Request) => {
    const contentType = req.headers.get("content-type");
    let data: unknown;

    if (contentType?.includes("application/json")) {
      data = await req.json();
    } else if (req.method === "GET") {
      const url = new URL(req.url);
      data = Object.fromEntries(url.searchParams.entries());
    } else {
      data = await req.text();
    }

    return validateRequest(schema, data);
  };
}

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type ReserveRequest = z.infer<typeof ReserveRequestSchema>;
export type ReserveResponse = z.infer<typeof ReserveResponseSchema>;
export type AvailabilityRequest = z.infer<typeof AvailabilityRequestSchema>;
export type AvailabilityResponse = z.infer<typeof AvailabilityResponseSchema>;
export type VerifyReservation = z.infer<typeof VerifyReservationSchema>;
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;
export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>;
export type CreateRestaurant = z.infer<typeof CreateRestaurantSchema>;
export type UpdateRestaurant = z.infer<typeof UpdateRestaurantSchema>;
export type JoinWaitlist = z.infer<typeof JoinWaitlistSchema>;
export type WaitlistPosition = z.infer<typeof WaitlistPositionSchema>;
export type DeliveryOrder = z.infer<typeof DeliveryOrderSchema>;
