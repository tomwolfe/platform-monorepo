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
} as const;

export const FIND_PRODUCT_NEARBY_TOOL = {
  name: "find_product_nearby",
  description: "Search for products in nearby stores based on location.",
  inputSchema: {
    type: "object",
    properties: {
      product_query: { type: "string" },
      user_lat: { type: "number" },
      user_lng: { type: "number" },
      max_radius_miles: { type: "number", default: 10 }
    },
    required: ["product_query", "user_lat", "user_lng"]
  }
} as const;

export const RESERVE_STOCK_ITEM_TOOL = {
  name: "reserve_stock_item",
  description: "Reserve a product at a specific store. REQUIRES CONFIRMATION.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      venue_id: { type: "string", description: "The store or restaurant ID." },
      quantity: { type: "number" }
    },
    required: ["product_id", "venue_id", "quantity"]
  }
} as const;

export const CHECK_AVAILABILITY_TOOL = {
  name: "check_availability",
  description: "Checks real-time table availability for a restaurant. Returns available tables and suggested slots if the requested time is full.",
  inputSchema: {
    type: "object",
    properties: {
      restaurantId: { type: "string", description: "The internal ID of the restaurant." },
      date: { type: "string", description: "ISO 8601 date and time (e.g., '2026-02-12T19:00:00Z')." },
      partySize: { type: "number", description: "Number of guests." }
    },
    required: ["restaurantId", "date", "partySize"]
  }
} as const;

export const BOOK_RESERVATION_TOOL = {
  name: "book_tablestack_reservation",
  description: "Finalizes a reservation on TableStack using a specific table ID. REQUIRES CONFIRMATION.",
  inputSchema: {
    type: "object",
    properties: {
      restaurantId: { type: "string", description: "The internal ID of the restaurant." },
      tableId: { type: "string", description: "The ID of the table to book (obtained from availability)." },
      guestName: { type: "string", description: "The name for the reservation." },
      guestEmail: { type: "string", description: "The email for the reservation." },
      partySize: { type: "number", description: "Number of guests." },
      startTime: { type: "string", description: "ISO 8601 start time." },
      is_confirmed: { type: "boolean", description: "Set to true ONLY if the user has explicitly confirmed these specific details." }
    },
    required: ["restaurantId", "tableId", "guestName", "guestEmail", "partySize", "startTime"]
  }
} as const;

export const DISCOVER_RESTAURANT_TOOL = {
  name: "discover_restaurant",
  description: "Resolves a restaurant slug to its internal ID and metadata using the TableStack API.",
  inputSchema: {
    type: "object",
    properties: {
      restaurant_slug: { type: "string", description: "The slug of the restaurant (e.g., 'the-fancy-bistro')." }
    },
    required: ["restaurant_slug"]
  }
} as const;

export const CREATE_PRODUCT_TOOL = {
  name: "create_product",
  description: "Create a new product in the system. REQUIRES CONFIRMATION. Only available for merchants.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Product name" },
      description: { type: "string", description: "Product description" },
      price: { type: "number", description: "Product price" },
      category: { type: "string", description: "Product category" }
    },
    required: ["name", "price", "category"]
  }
} as const;

export const UPDATE_PRODUCT_TOOL = {
  name: "update_product",
  description: "Update an existing product. REQUIRES CONFIRMATION.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string", description: "The ID of the product to update" },
      name: { type: "string", description: "New product name" },
      description: { type: "string", description: "New product description" },
      price: { type: "number", description: "New product price" },
      category: { type: "string", description: "New product category" }
    },
    required: ["product_id"]
  }
} as const;

export const DELETE_PRODUCT_TOOL = {
  name: "delete_product",
  description: "Delete a product from the system. REQUIRES CONFIRMATION.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string", description: "The ID of the product to delete" }
    },
    required: ["product_id"]
  }
} as const;

export const GEOCODE_LOCATION_TOOL = {
  name: "geocode_location",
  description: "Converts city names, addresses, or place names to precise lat/lon coordinates.",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string" },
      userLocation: {
        type: "object",
        properties: {
          lat: { type: "number" },
          lng: { type: "number" }
        }
      }
    },
    required: ["location"]
  }
} as const;

export const SEARCH_RESTAURANT_TOOL = {
  name: "search_restaurant",
  description: "Search for restaurants based on cuisine and location.",
  inputSchema: {
    type: "object",
    properties: {
      cuisine: { type: "string" },
      lat: { type: "number" },
      lon: { type: "number" },
      location: { type: "string" },
      userLocation: {
        type: "object",
        properties: {
          lat: { type: "number" },
          lng: { type: "number" }
        }
      }
    }
  }
} as const;

export const ADD_CALENDAR_EVENT_TOOL = {
  name: "add_calendar_event",
  description: "Add one or more events to the calendar.",
  inputSchema: {
    type: "object",
    properties: {
      events: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            start_time: { type: "string" },
            end_time: { type: "string" },
            location: { type: "string" },
            restaurant_name: { type: "string" },
            restaurant_address: { type: "string" }
          },
          required: ["title", "start_time", "end_time"]
        }
      }
    },
    required: ["events"]
  }
} as const;

export const GET_LOCAL_VENDORS_TOOL = {
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
} as const;

export const QUOTE_DELIVERY_TOOL = {
  name: "quote_delivery",
  description: "Get a delivery price and time estimate.",
  inputSchema: {
    type: "object",
    properties: {
      pickup_address: { type: "string" },
      delivery_address: { type: "string" },
      items: { type: "array", items: { type: "string" } },
      restaurant_id: { type: "string", description: "The TableStack restaurant ID to check for kitchen load." },
      system_key: { type: "string", description: "Internal system key for special offers." }
    },
    required: ["pickup_address", "delivery_address", "items"]
  }
} as const;

export const CHECK_KITCHEN_LOAD_TOOL = {
  name: "check_kitchen_load",
  description: "Check the current load of a restaurant's kitchen including active reservations and waitlist.",
  inputSchema: {
    type: "object",
    properties: {
      restaurant_id: { type: "string", description: "The TableStack restaurant ID." }
    },
    required: ["restaurant_id"]
  }
} as const;

export const TOOL_METADATA = {
  get_local_vendors: { requires_confirmation: false },
  quote_delivery: { requires_confirmation: false },
  check_kitchen_load: { requires_confirmation: false },
  dispatch_intent: { requires_confirmation: true },
  find_product_nearby: { requires_confirmation: false },
  reserve_stock_item: { requires_confirmation: true },
  check_availability: { requires_confirmation: false },
  book_tablestack_reservation: { requires_confirmation: true },
  discover_restaurant: { requires_confirmation: false },
  create_product: { requires_confirmation: true },
  update_product: { requires_confirmation: true },
  delete_product: { requires_confirmation: true }
};

export const PARAMETER_ALIASES = {
  "restaurant_id": "venue_id",
  "merchant_id": "venue_id",
  "restaurantName": "pickup_address",
  "restaurant_name": "pickup_address",
  "pickup_address": "restaurant_address",
  "delivery_address": "target_address",
  "venue_id": "store_id",
  "vendor_id": "store_id",
  "shop_id": "store_id"
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

export const FindProductSchema = z.object({
  product_query: z.string(),
  user_lat: z.number(),
  user_lng: z.number(),
  max_radius_miles: z.number().default(10)
});

export const ReserveStockSchema = z.object({
  product_id: z.string(),
  venue_id: z.string(),
  quantity: z.number().int().positive()
});

export const CheckAvailabilitySchema = z.object({
  restaurantId: z.string(),
  date: z.string(),
  partySize: z.number()
});

export const BookReservationSchema = z.object({
  restaurantId: z.string(),
  tableId: z.string(),
  guestName: z.string(),
  guestEmail: z.string(),
  partySize: z.number(),
  startTime: z.string(),
  is_confirmed: z.boolean().optional()
});

export const DiscoverRestaurantSchema = z.object({
  restaurant_slug: z.string()
});

export const GeocodeSchema = z.object({
  location: z.string(),
  userLocation: z.object({
    lat: z.number(),
    lng: z.number()
  }).optional()
});

export const SearchRestaurantSchema = z.object({
  cuisine: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  location: z.string().optional(),
  userLocation: z.object({
    lat: z.number(),
    lng: z.number()
  }).optional()
});

export const EventItemSchema = z.object({
  title: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  location: z.string().optional(),
  restaurant_name: z.string().optional(),
  restaurant_address: z.string().optional()
});

export const AddCalendarEventSchema = z.object({
  events: z.array(EventItemSchema)
});

export type DeliveryIntent = z.infer<typeof DeliveryIntentSchema>;
export type FindProduct = z.infer<typeof FindProductSchema>;
export type ReserveStock = z.infer<typeof ReserveStockSchema>;
export type CheckAvailability = z.infer<typeof CheckAvailabilitySchema>;
export type BookReservation = z.infer<typeof BookReservationSchema>;
export type DiscoverRestaurant = z.infer<typeof DiscoverRestaurantSchema>;

export type ToolInput = Record<string, unknown>;
export type ToolOutput = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
