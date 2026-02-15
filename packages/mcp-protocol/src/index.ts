import { z } from "zod";

export const DISPATCH_INTENT_TOOL = {
  name: "dispatch_intent",
  description: "Dispatch a delivery intent to the driver network. REQUIRES CONFIRMATION.",
  inputSchema: {
    type: "object",
    properties: {
      order_id: { type: "string" },
      pickup_address: { type: "string" },
      delivery_address: { type: "string" },
      customer_id: { type: "string" },
      restaurant_id: { type: "string", description: "The TableStack restaurant ID to notify." },
      priority: { type: "boolean", description: "Set to true for high-value guests to trigger priority driver matching." },
      price_details: {
        type: "object",
        properties: {
          base_pay: { type: "number" },
          tip: { type: "number" },
          total: { type: "number" }
        },
        required: ["base_pay", "tip", "total"]
      }
    },
    required: ["order_id", "pickup_address", "delivery_address", "customer_id", "price_details"]
  }
};

export const TOOL_METADATA = {
  get_local_vendors: { requires_confirmation: false },
  quote_delivery: { requires_confirmation: false },
  check_kitchen_load: { requires_confirmation: false },
  dispatch_intent: { requires_confirmation: true }
};

export const parameter_aliases = {
  "restaurant_id": "venue_id",
  "merchant_id": "venue_id",
  "restaurantName": "pickup_address",
  "restaurant_name": "pickup_address",
  "pickup_address": "restaurant_address",
  "delivery_address": "target_address",
};

// Zod schemas for shared use
export const DeliveryIntentSchema = z.object({
  order_id: z.string(),
  pickup_address: z.string(),
  delivery_address: z.string(),
  customer_id: z.string(),
  restaurant_id: z.string().optional(),
  priority: z.boolean().optional(),
  price_details: z.object({
    base_pay: z.number(),
    tip: z.number(),
    total: z.number()
  })
});

export type DeliveryIntent = z.infer<typeof DeliveryIntentSchema>;
