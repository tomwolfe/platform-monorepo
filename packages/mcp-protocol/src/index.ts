import * as zod from "zod";
const z = zod.z;

export * from "./schemas/mobility";
export * from "./schemas/booking";
export * from "./schemas/opendelivery";
export * from "./schemas/communication";
export * from "./schemas/context";
export * from "./schemas/operational_state";
export * from "./schemas/parallel_execution";
export * from "./schemas/table_management";
export * from "./schemas/delivery_fulfillment";

// Phase 2: Event Backbone
export * from "./schemas/events";

// Phase 3: Saga Patterns
export * from "./schemas/compensations";

// Phase 4: State Machine & Safety (Vercel Hobby Tier Optimization)
export * from "./schemas/state-machine";

import { MobilityRequestSchema, RouteEstimateSchema } from "./schemas/mobility";
import { GetAvailabilitySchema, BookTableSchema, TableReservationSchema } from "./schemas/booking";
import { CalculateQuoteSchema, GetDriverLocationSchema } from "./schemas/opendelivery";
import { CommunicationSchema } from "./schemas/communication";
import { WeatherSchema, WeatherDataSchema } from "./schemas/context";
import { GetLiveOperationalStateSchema, LiveStateSchema } from "./schemas/operational_state";
import {
  ParallelExecutionSchema,
  StepDependencySchema,
  ParallelExecutionResultSchema,
  DependencyResolverInputSchema,
  DependencyResolverOutputSchema,
} from "./schemas/parallel_execution";
import {
  GetTableAvailabilitySchema,
  GetTableLayoutSchema,
  GetReservationSchema,
  ListReservationsSchema,
  CheckTableConflictsSchema,
  CreateReservationSchema,
  UpdateReservationSchema,
  CancelReservationSchema,
  AddToWaitlistSchema,
  UpdateWaitlistStatusSchema,
  ValidateReservationSchema,
} from "./schemas/table_management";
import {
  CalculateDeliveryQuoteSchema,
  IntentFulfillmentSchema,
  GetFulfillmentStatusSchema,
  CancelFulfillmentSchema,
  UpdateFulfillmentSchema,
  ValidateFulfillmentSchema,
  DeliveryAddressSchema,
  DeliveryItemSchema,
} from "./schemas/delivery_fulfillment";

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
  tableManagement: {
    getTableAvailability: {
      name: "get_table_availability",
      description: "Check table availability for a specific date and party size.",
      schema: GetTableAvailabilitySchema,
    },
    getTableLayout: {
      name: "get_table_layout",
      description: "Retrieve the table layout for a restaurant.",
      schema: GetTableLayoutSchema,
    },
    getReservation: {
      name: "get_reservation",
      description: "Retrieve a specific reservation by ID.",
      schema: GetReservationSchema,
    },
    listReservations: {
      name: "list_reservations",
      description: "List reservations for a restaurant with optional filters.",
      schema: ListReservationsSchema,
    },
    checkTableConflicts: {
      name: "check_table_conflicts",
      description: "Check for conflicting reservations before booking.",
      schema: CheckTableConflictsSchema,
    },
    createReservation: {
      name: "create_reservation",
      description: "Create a new table reservation. REQUIRES CONFIRMATION.",
      schema: CreateReservationSchema,
    },
    updateReservation: {
      name: "update_reservation",
      description: "Update an existing reservation. REQUIRES CONFIRMATION.",
      schema: UpdateReservationSchema,
    },
    cancelReservation: {
      name: "cancel_reservation",
      description: "Cancel a reservation. REQUIRES CONFIRMATION.",
      schema: CancelReservationSchema,
    },
    addToWaitlist: {
      name: "add_to_waitlist",
      description: "Add a party to the restaurant waitlist.",
      schema: AddToWaitlistSchema,
    },
    updateWaitlistStatus: {
      name: "update_waitlist_status",
      description: "Update the status of a waitlist entry.",
      schema: UpdateWaitlistStatusSchema,
    },
    validateReservation: {
      name: "validate_reservation",
      description: "Validate a reservation without creating it (dry run).",
      schema: ValidateReservationSchema,
    },
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
  deliveryFulfillment: {
    calculateDeliveryQuote: {
      name: "calculate_delivery_quote",
      description: "Calculate a detailed delivery quote with pricing breakdown.",
      schema: CalculateDeliveryQuoteSchema,
    },
    fulfillIntent: {
      name: "fulfill_intent",
      description: "Dispatch a delivery intent to the driver network. REQUIRES CONFIRMATION.",
      schema: IntentFulfillmentSchema,
    },
    getFulfillmentStatus: {
      name: "get_fulfillment_status",
      description: "Check the real-time status of a delivery fulfillment.",
      schema: GetFulfillmentStatusSchema,
    },
    cancelFulfillment: {
      name: "cancel_fulfillment",
      description: "Cancel an in-progress delivery fulfillment. REQUIRES CONFIRMATION.",
      schema: CancelFulfillmentSchema,
    },
    updateFulfillment: {
      name: "update_fulfillment",
      description: "Update an active fulfillment details. REQUIRES CONFIRMATION.",
      schema: UpdateFulfillmentSchema,
    },
    validateFulfillment: {
      name: "validate_fulfillment",
      description: "Validate a fulfillment without dispatching (dry run).",
      schema: ValidateFulfillmentSchema,
    },
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
      schema: WeatherDataSchema,
    }
  },
  parallelExecution: {
    resolveDependencies: {
      name: "resolve_dependencies",
      description: "Analyze and resolve dependencies for parallel task execution.",
      schema: DependencyResolverInputSchema,
    },
    executeParallel: {
      name: "execute_parallel",
      description: "Execute multiple steps in parallel with dependency resolution.",
      schema: ParallelExecutionSchema,
    },
  },
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

export const GET_WEATHER_DATA_TOOL = {
  name: "get_weather_data",
  description: "Authorized to access real-time weather data. Provides live forecasts and current conditions with full meteorological authority.",
  inputSchema: {
    type: "object",
    properties: {
      lat: { type: "number", description: "Latitude of the location." },
      lon: { type: "number", description: "Longitude of the location." }
    },
    required: ["lat", "lon"]
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
  check_availability: { requires_confirmation: false },
  book_tablestack_reservation: { requires_confirmation: true },
  discover_restaurant: { requires_confirmation: false },
  // Table Management
  get_table_availability: { requires_confirmation: false },
  get_table_layout: { requires_confirmation: false },
  get_reservation: { requires_confirmation: false },
  list_reservations: { requires_confirmation: false },
  check_table_conflicts: { requires_confirmation: false },
  create_reservation: { requires_confirmation: true },
  update_reservation: { requires_confirmation: true },
  cancel_reservation: { requires_confirmation: true },
  add_to_waitlist: { requires_confirmation: false },
  update_waitlist_status: { requires_confirmation: false },
  validate_reservation: { requires_confirmation: false },
  // Delivery Fulfillment
  calculate_delivery_quote: { requires_confirmation: false },
  fulfill_intent: { requires_confirmation: true },
  get_fulfillment_status: { requires_confirmation: false },
  cancel_fulfillment: { requires_confirmation: true },
  update_fulfillment: { requires_confirmation: true },
  validate_fulfillment: { requires_confirmation: false },
  // Parallel Execution
  resolve_dependencies: { requires_confirmation: false },
  execute_parallel: { requires_confirmation: false },
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
