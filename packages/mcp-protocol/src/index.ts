import * as zod from "zod";
const z = zod.z;

export * from "./schemas/mobility";
export * from "./schemas/booking";
export * from "./schemas/opendelivery";
export * from "./schemas/storefront";
export * from "./schemas/communication";
export * from "./schemas/context";
export * from "./schemas/operational_state";

import { MobilityRequestSchema, RouteEstimateSchema } from "./schemas/mobility";
import { GetAvailabilitySchema, BookTableSchema, TableReservationSchema } from "./schemas/booking";
import { CalculateQuoteSchema, GetDriverLocationSchema } from "./schemas/opendelivery";
import { ListVendorsSchema, GetMenuSchema, FindProductNearbySchema, ReserveStockItemSchema, CreateProductSchema, UpdateProductSchema, DeleteProductSchema } from "./schemas/storefront";
import { CommunicationSchema } from "./schemas/communication";
import { WeatherSchema } from "./schemas/context";
import { GetLiveOperationalStateSchema, LiveStateSchema } from "./schemas/operational_state";

export const ToolCapabilitySchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.any(),
  requires_confirmation: z.boolean().default(false),
});

export const AppCapabilitiesSchema = z.object({
  app_name: z.string(),
  version: z.string(),
  tools: z.array(ToolCapabilitySchema),
});

export type ToolCapability = zod.infer<typeof ToolCapabilitySchema>;
export type AppCapabilities = zod.infer<typeof AppCapabilitiesSchema>;

export const TOOLS = {
  tableStack: {
    getAvailability: {
      name: "getAvailability",
      description: "Checks real-time table availability for a restaurant.",
      schema: GetAvailabilitySchema,
    },
    bookTable: {
      name: "bookTable",
      description: "Finalizes a reservation on TableStack. REQUIRES CONFIRMATION.",
      schema: BookTableSchema,
    },
    getLiveOperationalState: {
      name: "getLiveOperationalState",
      description: "Retrieve real-time table status for a restaurant.",
      schema: GetLiveOperationalStateSchema,
    }
  },
  openDelivery: {
    calculateQuote: {
      name: "calculateQuote",
      description: "Get a delivery price and time estimate.",
      schema: CalculateQuoteSchema,
    },
    getDriverLocation: {
      name: "getDriverLocation",
      description: "Retrieve the real-time location of the delivery driver.",
      schema: GetDriverLocationSchema,
    }
  },
  storeFront: {
    listVendors: {
      name: "listVendors",
      description: "Search for local vendors (stores, restaurants) based on location.",
      schema: ListVendorsSchema,
    },
    getMenu: {
      name: "getMenu",
      description: "Retrieve the menu/product list for a specific store.",
      schema: GetMenuSchema,
    },
    findProductNearby: {
      name: "find_product_nearby",
      description: "Search for products in nearby stores based on location.",
      schema: FindProductNearbySchema,
    },
    reserveStockItem: {
      name: "reserve_stock_item",
      description: "Reserve a product at a specific store. REQUIRES CONFIRMATION.",
      schema: ReserveStockItemSchema,
    }
  },
  mobility: {
    requestRide: {
      name: "request_ride",
      description: "Authorized to perform real-time ride requests from mobility services.",
      schema: MobilityRequestSchema,
    },
    getRouteEstimate: {
      name: "get_route_estimate",
      description: "Authorized to access real-time routing data.",
      schema: RouteEstimateSchema,
    }
  },
  booking: {
    reserveRestaurant: {
      name: "reserve_restaurant",
      description: "Authorized to perform restaurant reservations.",
      schema: TableReservationSchema,
    }
  },
  communication: {
    sendComm: {
      name: "send_comm",
      description: "Authorized to perform real-time communications.",
      schema: CommunicationSchema,
    }
  },
  context: {
    getWeather: {
      name: "get_weather_data",
      description: "Authorized to access real-time weather data.",
      schema: WeatherSchema,
    }
  }
} as const;

export type McpToolRegistry = typeof TOOLS;

// Legacy tool definitions...
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
      restaurant_id: { type: "string" },
      priority: { type: "boolean" },
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
      venue_id: { type: "string" },
      quantity: { type: "number" }
    },
    required: ["product_id", "venue_id", "quantity"]
  }
} as const;

export const CHECK_AVAILABILITY_TOOL = {
  name: "check_availability",
  description: "Checks real-time table availability for a restaurant.",
  inputSchema: {
    type: "object",
    properties: {
      restaurantId: { type: "string" },
      date: { type: "string" },
      partySize: { type: "number" }
    },
    required: ["restaurantId", "date", "partySize"]
  }
} as const;

export const BOOK_RESERVATION_TOOL = {
  name: "book_tablestack_reservation",
  description: "Finalizes a reservation on TableStack. REQUIRES CONFIRMATION.",
  inputSchema: {
    type: "object",
    properties: {
      restaurantId: { type: "string" },
      tableId: { type: "string" },
      guestName: { type: "string" },
      guestEmail: { type: "string" },
      partySize: { type: "number" },
      startTime: { type: "string" }
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
      restaurant_slug: { type: "string" }
    },
    required: ["restaurant_slug"]
  }
} as const;

export const GEOCODE_LOCATION_TOOL = {
  name: "geocode_location",
  description: "Converts city names, addresses, or place names to precise lat/lon coordinates.",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string" }
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
      location: { type: "string" }
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
            end_time: { type: "string" }
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
      radius_km: { type: "number" }
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
      items: { type: "array", items: { type: "string" } }
    },
    required: ["pickup_address", "delivery_address", "items"]
  }
} as const;

export const CHECK_KITCHEN_LOAD_TOOL = {
  name: "check_kitchen_load",
  description: "Check the current load of a restaurant's kitchen.",
  inputSchema: {
    type: "object",
    properties: {
      restaurant_id: { type: "string" }
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
  discover_restaurant: { requires_confirmation: false }
};

export const PARAMETER_ALIASES = {
  "restaurant_id": "venue_id",
  "merchant_id": "venue_id",
  "restaurantName": "pickup_address",
  "restaurant_name": "pickup_address",
  "pickup_address": "restaurant_address",
  "delivery_address": "target_address",
};

export const UserLocationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});

export const GeocodeSchema = z.object({
  location: z.string(),
  userLocation: UserLocationSchema.optional(),
});

export const SearchRestaurantSchema = z.object({
  cuisine: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  location: z.string().optional(),
  userLocation: UserLocationSchema.optional(),
});

export const EventItemSchema = z.object({
  title: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  location: z.string().optional(),
  restaurant_name: z.string().optional(),
  restaurant_address: z.string().optional(),
});

export const AddCalendarEventSchema = z.object({
  events: z.array(EventItemSchema)
});

export * from './bridge';

export type ToolInput = Record<string, unknown>;
export type ToolOutput = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
