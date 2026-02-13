import { Tool } from "@modelcontextprotocol/sdk/types.js";

export const GET_LOCAL_VENDORS_TOOL: Tool = {
  name: "get_local_vendors",
  description: "Search for local vendors (restaurants, shops) based on location using Photon API.",
  inputSchema: {
    type: "object",
    properties: {
      latitude: { type: "number" },
      longitude: { type: "number" },
      radius_km: { type: "number" },
      category: { type: "string" }
    },
    required: ["latitude", "longitude"]
  }
};

export const QUOTE_DELIVERY_TOOL: Tool = {
  name: "quote_delivery",
  description: "Get a delivery price and time estimate.",
  inputSchema: {
    type: "object",
    properties: {
      pickup_address: { type: "string" },
      delivery_address: { type: "string" },
      items: { type: "array", items: { type: "string" } }
    },
    required: ["pickup_address", "delivery_address", "items"]
  }
};

export const DISPATCH_INTENT_TOOL: Tool = {
  name: "dispatch_intent",
  description: "Dispatch a delivery intent to the driver network. REQUIRES CONFIRMATION.",
  inputSchema: {
    type: "object",
    properties: {
      order_id: { type: "string" },
      pickup_address: { type: "string" },
      delivery_address: { type: "string" },
      customer_id: { type: "string" },
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

// Custom metadata for IntentionEngine integration
export const TOOL_METADATA = {
  get_local_vendors: { requires_confirmation: false },
  quote_delivery: { requires_confirmation: false },
  dispatch_intent: { requires_confirmation: true }
};
