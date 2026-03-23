import { z } from "zod";

export const CalculateQuoteSchema = z.object({
  pickup_address: z.string().describe("Address where the delivery starts."),
  delivery_address: z.string().describe("Address where the delivery ends."),
  items: z.array(z.string()).describe("List of items to be delivered.")
});

export const GetDriverLocationSchema = z.object({
  order_id: z.string().describe("The unique identifier of the order.")
});

// ============================================================================
// OPENDELIVER MCP SERVER SPECIFIC SCHEMAS
// These schemas are used by the open-delivery MCP server implementation
// ============================================================================

/**
 * CheckKitchenLoadSchema - OpenDeliver MCP server tool
 */
export const CheckKitchenLoadSchema = z.object({
  restaurant_id: z.string().uuid().describe("The internal ID of the restaurant"),
});

/**
 * GetLocalVendorsSchema - OpenDeliver MCP server tool
 */
export const GetLocalVendorsSchema = z.object({
  latitude: z.number().describe("Latitude of the search center"),
  longitude: z.number().describe("Longitude of the search center"),
  radius_km: z.number().optional().default(5).describe("Search radius in kilometers"),
});

/**
 * QuoteDeliverySchema - OpenDeliver MCP server tool
 */
export const QuoteDeliverySchema = z.object({
  pickup_address: z.string().describe("Address where the delivery starts"),
  delivery_address: z.string().describe("Address where the delivery ends"),
  restaurant_id: z.string().uuid().optional().describe("Optional restaurant ID for kitchen load check"),
  system_key: z.string().optional().describe("Optional system key for special offers"),
});

/**
 * DispatchIntentSchema - OpenDeliver MCP server tool
 */
export const DispatchIntentSchema = z.object({
  order_id: z.string().describe("The unique identifier of the order"),
  pickup_address: z.string().describe("Address where the delivery starts"),
  delivery_address: z.string().describe("Address where the delivery ends"),
  customer_id: z.string().describe("The customer's ID"),
  max_price: z.number().optional().describe("Maximum price the customer is willing to pay"),
  restaurant_id: z.string().uuid().optional().describe("Optional restaurant ID"),
  priority: z.boolean().optional().describe("Whether this is a priority delivery"),
});
