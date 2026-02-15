/**
 * Delivery Fulfillment Schemas for MCP Protocol
 * Based on OpenDeliver service capabilities and database models
 */

import { z } from "zod";

// ============================================================================
// DELIVERY QUOTE & ESTIMATION
// ============================================================================

/**
 * DeliveryItemSchema - Individual item in a delivery order
 */
export const DeliveryItemSchema = z.object({
  id: z.string().optional().describe("Item identifier"),
  name: z.string().min(1).max(200).describe("Name of the item"),
  quantity: z.number().int().positive().default(1).describe("Quantity of the item"),
  weight: z.number().positive().optional().describe("Weight in kg (for routing calculations)"),
  dimensions: z.object({
    length: z.number().positive(),
    width: z.number().positive(),
    height: z.number().positive(),
  }).optional().describe("Dimensions in cm (for vehicle capacity)"),
  requiresRefrigeration: z.boolean().default(false).describe("Whether item needs cold storage"),
  fragile: z.boolean().default(false).describe("Whether item requires careful handling"),
});

/**
 * DeliveryAddressSchema - Structured address format
 */
export const DeliveryAddressSchema = z.object({
  street: z.string().min(1).describe("Street address"),
  city: z.string().min(1).describe("City"),
  state: z.string().optional().describe("State/Province"),
  zipCode: z.string().optional().describe("Postal/ZIP code"),
  country: z.string().default("US").describe("Country code"),
  lat: z.number().min(-90).max(90).optional().describe("Latitude"),
  lng: z.number().min(-180).max(180).optional().describe("Longitude"),
  instructions: z.string().max(500).optional().describe("Special delivery instructions"),
});

/**
 * CalculateDeliveryQuoteSchema - Get a delivery price estimate
 */
export const CalculateDeliveryQuoteSchema = z.object({
  pickupAddress: DeliveryAddressSchema.describe("Address where items will be picked up"),
  deliveryAddress: DeliveryAddressSchema.describe("Address where items will be delivered"),
  items: z.array(DeliveryItemSchema).min(1).describe("Items to be delivered"),
  scheduledPickupTime: z.string().datetime().optional().describe("Preferred pickup time"),
  priority: z.enum(["standard", "express", "urgent"]).default("standard").describe("Delivery priority level"),
  vehicleType: z.enum(["bike", "car", "van", "truck"]).optional().describe("Required vehicle type"),
});

/**
 * DeliveryQuoteResultSchema - Result of a delivery quote calculation
 */
export const DeliveryQuoteResultSchema = z.object({
  quoteId: z.string().uuid().describe("Unique identifier for this quote"),
  validUntil: z.string().datetime().describe("Quote expiration time"),
  price: z.object({
    base: z.number().nonnegative().describe("Base delivery fee"),
    distance: z.number().nonnegative().describe("Distance-based fee"),
    weight: z.number().nonnegative().describe("Weight-based fee"),
    priority: z.number().nonnegative().describe("Priority surcharge"),
    total: z.number().nonnegative().describe("Total price"),
    currency: z.string().default("USD").describe("Currency code"),
  }),
  estimatedTime: z.object({
    pickupMinutes: z.number().int().nonnegative().describe("Estimated minutes until pickup"),
    deliveryMinutes: z.number().int().nonnegative().describe("Estimated transit time in minutes"),
    totalMinutes: z.number().int().nonnegative().describe("Total estimated time"),
  }),
  availableVehicles: z.array(z.enum(["bike", "car", "van", "truck"])).describe("Available vehicle types"),
  route: z.object({
    distanceKm: z.number().positive().describe("Route distance in kilometers"),
    polyline: z.string().optional().describe("Encoded route polyline"),
  }).optional(),
});

// ============================================================================
// INTENT FULFILLMENT - DISPATCH & TRACKING
// ============================================================================

/**
 * IntentFulfillmentSchema - Dispatch a delivery intent to the driver network
 * REQUIRES CONFIRMATION
 */
export const IntentFulfillmentSchema = z.object({
  quoteId: z.string().uuid().describe("ID of the accepted quote"),
  orderId: z.string().uuid().optional().describe("External order ID (if pre-existing)"),
  customerId: z.string().describe("Customer identifier"),
  customerName: z.string().min(1).describe("Customer name"),
  customerPhone: z.string().describe("Customer phone number"),
  pickupAddress: DeliveryAddressSchema.describe("Pickup location"),
  deliveryAddress: DeliveryAddressSchema.describe("Delivery location"),
  items: z.array(DeliveryItemSchema).min(1).describe("Items to deliver"),
  priceDetails: z.object({
    basePay: z.number().nonnegative().describe("Base pay for driver"),
    tip: z.number().nonnegative().default(0).describe("Customer tip"),
    total: z.number().nonnegative().describe("Total price"),
    currency: z.string().default("USD"),
  }),
  priority: z.boolean().default(false).describe("Priority delivery flag"),
  scheduledPickupTime: z.string().datetime().optional().describe("Scheduled pickup time"),
  specialInstructions: z.string().max(1000).optional().describe("Special instructions for driver"),
  callbackUrl: z.string().url().optional().describe("Webhook URL for status updates"),
});

/**
 * FulfillmentResultSchema - Result of dispatching an intent
 */
export const FulfillmentResultSchema = z.object({
  fulfillmentId: z.string().uuid().describe("Unique identifier for this fulfillment"),
  orderId: z.string().uuid().describe("Order ID"),
  status: z.enum(["pending", "searching", "matched", "pickup", "transit", "delivered", "cancelled", "failed"]),
  driver: z.object({
    id: z.string().describe("Driver ID"),
    name: z.string().describe("Driver name"),
    phone: z.string().describe("Driver phone"),
    vehicleType: z.string().describe("Vehicle type"),
    rating: z.number().min(1).max(5).optional().describe("Driver rating"),
  }).optional().describe("Assigned driver (if matched)"),
  estimatedTimes: z.object({
    driverArrival: z.string().datetime().optional().describe("When driver will arrive at pickup"),
    pickup: z.string().datetime().optional().describe("Expected pickup time"),
    delivery: z.string().datetime().optional().describe("Expected delivery time"),
  }),
  tracking: z.object({
    url: z.string().url().optional().describe("Customer tracking URL"),
    code: z.string().optional().describe("Tracking code"),
  }),
  createdAt: z.string().datetime(),
});

/**
 * GetFulfillmentStatusSchema - Check the status of a fulfillment
 */
export const GetFulfillmentStatusSchema = z.object({
  fulfillmentId: z.string().uuid().describe("Fulfillment ID to check"),
});

/**
 * FulfillmentStatusResultSchema - Current status of a fulfillment
 */
export const FulfillmentStatusResultSchema = z.object({
  fulfillmentId: z.string().uuid(),
  orderId: z.string().uuid(),
  status: z.enum(["pending", "searching", "matched", "pickup", "transit", "delivered", "cancelled", "failed"]),
  driver: z.object({
    id: z.string(),
    name: z.string(),
    phone: z.string(),
    currentLocation: z.object({
      lat: z.number(),
      lng: z.number(),
      bearing: z.number().optional(),
      timestamp: z.string().datetime(),
    }).optional(),
    estimatedArrival: z.string().datetime().optional(),
  }).optional(),
  route: z.object({
    currentLeg: z.enum(["to_pickup", "to_delivery"]),
    progressPercent: z.number().min(0).max(100),
    remainingDistanceKm: z.number().nonnegative(),
    remainingTimeMinutes: z.number().int().nonnegative(),
  }).optional(),
  events: z.array(z.object({
    timestamp: z.string().datetime(),
    event: z.string(),
    details: z.unknown().optional(),
  })),
  updatedAt: z.string().datetime(),
});

// ============================================================================
// DRIVER & LOCATION
// ============================================================================

/**
 * GetDriverLocationSchema - Get real-time driver location
 */
export const GetDriverLocationSchema = z.object({
  fulfillmentId: z.string().uuid().describe("Fulfillment ID"),
});

/**
 * DriverLocationResultSchema - Driver location response
 */
export const DriverLocationResultSchema = z.object({
  fulfillmentId: z.string().uuid(),
  driverId: z.string(),
  location: z.object({
    lat: z.number(),
    lng: z.number(),
  }),
  bearing: z.number().min(0).max(359).optional().describe("Direction in degrees"),
  speed: z.number().nonnegative().optional().describe("Speed in km/h"),
  accuracy: z.number().nonnegative().optional().describe("Location accuracy in meters"),
  timestamp: z.string().datetime(),
  estimatedArrival: z.object({
    pickup: z.string().datetime().optional(),
    delivery: z.string().datetime().optional(),
  }),
});

// ============================================================================
// CANCELLATION & MODIFICATION (REQUIRE CONFIRMATION)
// ============================================================================

/**
 * CancelFulfillmentSchema - Cancel an in-progress fulfillment
 * REQUIRES CONFIRMATION
 */
export const CancelFulfillmentSchema = z.object({
  fulfillmentId: z.string().uuid().describe("Fulfillment ID to cancel"),
  reason: z.enum(["customer_request", "restaurant_closed", "driver_unavailable", "other"]).describe("Cancellation reason"),
  details: z.string().max(500).optional().describe("Additional cancellation details"),
  chargeCancellationFee: z.boolean().default(false).describe("Whether to charge cancellation fee"),
});

/**
 * UpdateFulfillmentSchema - Update an active fulfillment
 * REQUIRES CONFIRMATION
 */
export const UpdateFulfillmentSchema = z.object({
  fulfillmentId: z.string().uuid().describe("Fulfillment ID to update"),
  deliveryAddress: DeliveryAddressSchema.optional().describe("New delivery address"),
  specialInstructions: z.string().max(1000).optional().describe("Updated instructions"),
  customerPhone: z.string().optional().describe("Updated contact phone"),
});

// ============================================================================
// VALIDATION SCHEMAS (DRY RUN)
// ============================================================================

/**
 * ValidateFulfillmentSchema - Validate a fulfillment without creating it
 */
export const ValidateFulfillmentSchema = z.object({
  pickupAddress: DeliveryAddressSchema.describe("Pickup location"),
  deliveryAddress: DeliveryAddressSchema.describe("Delivery location"),
  items: z.array(DeliveryItemSchema).min(1).describe("Items to validate"),
  priority: z.boolean().default(false).describe("Priority delivery"),
});

/**
 * FulfillmentValidationResultSchema - Validation result
 */
export const FulfillmentValidationResultSchema = z.object({
  valid: z.boolean().describe("Whether the fulfillment is valid"),
  errors: z.array(z.object({
    field: z.string(),
    message: z.string(),
    code: z.string(),
  })).optional().describe("Validation errors"),
  warnings: z.array(z.string()).optional().describe("Validation warnings"),
  estimatedAvailability: z.object({
    vehicleTypes: z.array(z.enum(["bike", "car", "van", "truck"])),
    earliestPickup: z.string().datetime(),
    estimatedDelivery: z.string().datetime(),
  }).optional(),
});

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type DeliveryItem = z.infer<typeof DeliveryItemSchema>;
export type DeliveryAddress = z.infer<typeof DeliveryAddressSchema>;
export type CalculateDeliveryQuote = z.infer<typeof CalculateDeliveryQuoteSchema>;
export type DeliveryQuoteResult = z.infer<typeof DeliveryQuoteResultSchema>;
export type IntentFulfillment = z.infer<typeof IntentFulfillmentSchema>;
export type FulfillmentResult = z.infer<typeof FulfillmentResultSchema>;
export type GetFulfillmentStatus = z.infer<typeof GetFulfillmentStatusSchema>;
export type FulfillmentStatusResult = z.infer<typeof FulfillmentStatusResultSchema>;
export type GetDriverLocation = z.infer<typeof GetDriverLocationSchema>;
export type DriverLocationResult = z.infer<typeof DriverLocationResultSchema>;
export type CancelFulfillment = z.infer<typeof CancelFulfillmentSchema>;
export type UpdateFulfillment = z.infer<typeof UpdateFulfillmentSchema>;
export type ValidateFulfillment = z.infer<typeof ValidateFulfillmentSchema>;
export type FulfillmentValidationResult = z.infer<typeof FulfillmentValidationResultSchema>;
