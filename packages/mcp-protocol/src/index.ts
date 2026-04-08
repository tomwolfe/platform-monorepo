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
// Note: Excluding TableVacatedEventSchema to avoid conflict with event-registry
export {
  TaskStatusSchema,
  TaskStateTransitionSchema,
  TaskStateSchema,
  TaskQueueItemSchema,
  StateTransitionResultSchema,
  HighRiskToolCategorySchema,
  HighRiskToolSchema,
  IntentSafetyCheckSchema,
  SafetyPlanStepSchema,
  SafetyPlanSchema,
  SafetyIntentSchema,
  ConfirmationStatusSchema,
  ConfirmationRequestSchema,
  ConfirmationResponseSchema,
  UserContextMatchSchema,
  ProactiveNotificationSchema,
  ServiceRegistryEntrySchema,
  ToolCallContextSchema,
  ToolCallResultSchema,
  ParameterAliasSchema,
  StreamingStatusUpdateSchema,
  ValidStateTransitions,
  isTerminalStatus,
  isValidTransition,
} from "./schemas/state-machine";
export type {
  TaskStatus,
  TaskStateTransition,
  TaskState,
  TaskQueueItem,
  StateTransitionResult,
  HighRiskToolCategory,
  HighRiskTool,
  IntentSafetyCheck,
  SafetyPlanStep,
  SafetyPlan,
  SafetyIntent,
  ConfirmationStatus,
  ConfirmationRequest,
  ConfirmationResponse,
  UserContextMatch,
  ProactiveNotification,
  ServiceRegistryEntry,
  ToolCallContext,
  ToolCallResult,
  ParameterAlias,
  StreamingStatusUpdate,
} from "./schemas/state-machine";

import { MobilityRequestSchema, RouteEstimateSchema } from "./schemas/mobility";
import {
  GetAvailabilitySchema,
  BookTableSchema,
  TableReservationSchema,
} from "./schemas/booking";
import {
  CalculateQuoteSchema,
  GetDriverLocationSchema,
  CheckKitchenLoadSchema,
  GetLocalVendorsSchema,
  QuoteDeliverySchema,
  DispatchIntentSchema,
} from "./schemas/opendelivery";
import { CommunicationSchema } from "./schemas/communication";
import { WeatherSchema, WeatherDataSchema } from "./schemas/context";
import {
  GetLiveOperationalStateSchema,
  LiveStateSchema,
} from "./schemas/operational_state";
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
  CheckAvailabilitySchema,
  BookTablestackReservationSchema,
  DiscoverRestaurantSchema,
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
  inputSchema: z.record(z.string(), z.unknown()),
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
      description:
        "Finalizes a reservation on TableStack. REQUIRES CONFIRMATION.",
      schema: BookTableSchema,
    },
    getLiveOperationalState: {
      name: "getLiveOperationalState",
      description: "Retrieve real-time table status for a restaurant.",
      schema: GetLiveOperationalStateSchema,
    },
  },
  tableManagement: {
    getTableAvailability: {
      name: "get_table_availability",
      description:
        "Check table availability for a specific date and party size.",
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
    },
  },
  deliveryFulfillment: {
    calculateDeliveryQuote: {
      name: "calculate_delivery_quote",
      description:
        "Calculate a detailed delivery quote with pricing breakdown.",
      schema: CalculateDeliveryQuoteSchema,
    },
    fulfillIntent: {
      name: "fulfill_intent",
      description:
        "Dispatch a delivery intent to the driver network. REQUIRES CONFIRMATION.",
      schema: IntentFulfillmentSchema,
    },
    getFulfillmentStatus: {
      name: "get_fulfillment_status",
      description: "Check the real-time status of a delivery fulfillment.",
      schema: GetFulfillmentStatusSchema,
    },
    cancelFulfillment: {
      name: "cancel_fulfillment",
      description:
        "Cancel an in-progress delivery fulfillment. REQUIRES CONFIRMATION.",
      schema: CancelFulfillmentSchema,
    },
    updateFulfillment: {
      name: "update_fulfillment",
      description:
        "Update an active fulfillment details. REQUIRES CONFIRMATION.",
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
      description:
        "Authorized to perform real-time ride requests from mobility services.",
      schema: MobilityRequestSchema,
    },
    getRouteEstimate: {
      name: "get_route_estimate",
      description: "Authorized to access real-time routing data.",
      schema: RouteEstimateSchema,
    },
  },
  booking: {
    reserveRestaurant: {
      name: "reserve_restaurant",
      description: "Authorized to perform restaurant reservations.",
      schema: TableReservationSchema,
    },
  },
  communication: {
    sendComm: {
      name: "send_comm",
      description: "Authorized to perform real-time communications.",
      schema: CommunicationSchema,
    },
  },
  context: {
    getWeather: {
      name: "get_weather_data",
      description: "Authorized to access real-time weather data.",
      schema: WeatherDataSchema,
    },
  },
  parallelExecution: {
    resolveDependencies: {
      name: "resolve_dependencies",
      description:
        "Analyze and resolve dependencies for parallel task execution.",
      schema: DependencyResolverInputSchema,
    },
    executeParallel: {
      name: "execute_parallel",
      description:
        "Execute multiple steps in parallel with dependency resolution.",
      schema: ParallelExecutionSchema,
    },
  },
} as const;

export type McpToolRegistry = typeof TOOLS;

// ============================================================================
// LEGACY EXPORTS REMOVED
// The following legacy tool exports have been removed to encourage use of
// the typed TOOLS registry:
// - DISPATCH_INTENT_TOOL (use TOOLS.openDelivery.dispatchIntent)
// - GET_WEATHER_DATA_TOOL (use TOOLS.context.getWeatherData)
// - CHECK_AVAILABILITY_TOOL (use TOOLS.tableStack.getAvailability)
// - BOOK_RESERVATION_TOOL (use TOOLS.tableStack.bookTable)
// - DISCOVER_RESTAURANT_TOOL (use TOOLS.tableManagement.discoverRestaurant)
// - GEOCODE_LOCATION_TOOL (defined locally in intention-engine)
// - SEARCH_RESTAURANT_TOOL (defined locally in intention-engine)
// - ADD_CALENDAR_EVENT_TOOL (defined locally in intention-engine)
// - GET_LOCAL_VENDORS_TOOL (not in active use)
// - QUOTE_DELIVERY_TOOL (use TOOLS.openDelivery.calculateQuote)
// - CHECK_KITCHEN_LOAD_TOOL (not in active use)
//
// Migration guide:
// - Import from TOOLS registry: import { TOOLS } from "@repo/mcp-protocol";
// - Access typed tools: TOOLS.tableStack.getAvailability, TOOLS.context.getWeatherData, etc.
// ============================================================================

export const TOOL_METADATA = {
  // Table Management
  check_availability: { requires_confirmation: false },
  book_tablestack_reservation: { requires_confirmation: true },
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
  quote_delivery: { requires_confirmation: false },
  calculate_delivery_quote: { requires_confirmation: false },
  fulfill_intent: { requires_confirmation: true },
  get_fulfillment_status: { requires_confirmation: false },
  cancel_fulfillment: { requires_confirmation: true },
  update_fulfillment: { requires_confirmation: true },
  validate_fulfillment: { requires_confirmation: false },
  // Parallel Execution
  resolve_dependencies: { requires_confirmation: false },
  execute_parallel: { requires_confirmation: false },
} as const;

export type ToolMetadataKey = keyof typeof TOOL_METADATA;
export type ToolMetadataEntry = (typeof TOOL_METADATA)[ToolMetadataKey];

/**
 * PARAMETER ALIAS REGISTRY - CRITICAL FOR LLM PARAMETER NORMALIZATION
 *
 * This registry maps LLM-hallucinated parameter names (aliases) to canonical MCP parameter names.
 * The ParameterAliaser in mcp-client.ts automatically applies these aliases before tool execution.
 *
 * Format: { "alias_name": "canonical_name" }
 * Example: If LLM provides `venueId` but tool expects `restaurant_id`, alias is: "venueId": "restaurant_id"
 *
 * HOW TO UPDATE:
 * 1. When adding new MCP tools, identify all parameter names in the input schema
 * 2. Add aliases for common LLM hallucinations (e.g., camelCase vs snake_case, synonyms)
 * 3. Test with: "I want to book at venueId=123" -> should resolve to restaurant_id=123
 *
 * CATEGORIES:
 * - Location/Venue Identifiers
 * - Time/Date Fields
 * - Party/Group Size
 * - Contact Information
 * - Order/Transaction IDs
 * - Address Fields
 */
export const PARAMETER_ALIASES = {
  // ============================================================================
  // LOCATION / VENUE IDENTIFIERS
  // ============================================================================
  venue_id: "restaurant_id",
  venueId: "restaurant_id",
  merchant_id: "restaurant_id",
  merchantId: "restaurant_id",
  location_id: "restaurant_id",
  locationId: "restaurant_id",
  place_id: "restaurant_id",
  placeId: "restaurant_id",
  business_id: "restaurant_id",
  businessId: "restaurant_id",

  // ============================================================================
  // RESTAURANT NAME / ADDRESS ALIASES
  // ============================================================================
  restaurantName: "restaurant_name",
  restaurant_name: "pickup_address", // For delivery context
  restaurant_address: "pickup_address",
  pickup_address: "pickupAddress",
  pickupAddress: "pickup_address",
  pickup_location: "pickup_address",
  pickupLocation: "pickup_address",
  pickupLocationId: "pickup_address",

  // ============================================================================
  // DELIVERY ADDRESS ALIASES
  // ============================================================================
  delivery_address: "deliveryAddress",
  deliveryAddress: "delivery_address",
  delivery_location: "deliveryAddress",
  deliveryLocation: "deliveryAddress",
  dropoff_address: "deliveryAddress",
  dropoffAddress: "deliveryAddress",
  dropoff_location: "deliveryAddress",
  dropoffLocation: "deliveryAddress",
  target_address: "deliveryAddress",
  targetAddress: "deliveryAddress",
  destination_address: "deliveryAddress",
  destinationAddress: "deliveryAddress",
  destination_location: "deliveryAddress",
  destinationLocation: "deliveryAddress",

  // ============================================================================
  // TIME / DATE FIELDS
  // ============================================================================
  time: "reservation_time",
  reservationTime: "reservation_time",
  reservation_time: "time",
  booking_time: "time",
  bookingTime: "time",
  date: "reservation_date",
  reservationDate: "date",
  booking_date: "date",
  bookingDate: "date",
  datetime: "time",
  dateTime: "time",
  timestamp: "time",
  scheduled_time: "time",
  scheduledTime: "time",

  // ============================================================================
  // PARTY / GROUP SIZE
  // ============================================================================
  partySize: "party_size",
  party_size: "guests",
  guests: "party_size",
  numGuests: "party_size",
  num_guests: "party_size",
  groupSize: "party_size",
  group_size: "party_size",
  people: "party_size",
  personCount: "party_size",
  person_count: "party_size",
  attendees: "party_size",

  // ============================================================================
  // CONTACT INFORMATION
  // ============================================================================
  email: "userEmail",
  userEmail: "email",
  user_email: "email",
  customer_email: "email",
  customerEmail: "email",
  phone: "userPhone",
  userPhone: "phone",
  user_phone: "phone",
  customer_phone: "phone",
  customerPhone: "phone",
  phoneNumber: "phone",
  phone_number: "phone",

  // ============================================================================
  // ORDER / TRANSACTION IDS
  // ============================================================================
  order_id: "orderId",
  orderId: "order_id",
  orderNumber: "order_id",
  transaction_id: "order_id",
  transactionId: "order_id",
  booking_id: "reservationId",
  bookingId: "reservationId",
  reservation_id: "reservationId",
  reservationId: "reservation_id",
  confirmation_id: "reservationId",
  confirmationId: "reservationId",
  fulfillment_id: "fulfillmentId",
  fulfillmentId: "fulfillment_id",
  ride_id: "rideId",
  rideId: "ride_id",

  // ============================================================================
  // LOCATION COORDINATES
  // ============================================================================
  lat: "latitude",
  latitude: "lat",
  lng: "longitude",
  lon: "longitude",
  longitude: "lng",
  coordinates: "location",
  coords: "location",
  geo: "location",
  location_coords: "location",
  locationCoords: "location",

  // ============================================================================
  // SERVICE / PROVIDER SELECTION
  // ============================================================================
  service: "provider",
  provider: "service",
  vendor: "service",
  company: "service",
  ride_type: "service_level",
  rideType: "service_level",
  service_level: "ride_type",
  car_type: "ride_type",
  carType: "ride_type",
  vehicle_type: "ride_type",
  vehicleType: "ride_type",

  // ============================================================================
  // MISCELLANEOUS
  // ============================================================================
  notes: "special_requests",
  specialRequests: "special_requests",
  special_requests: "notes",
  instructions: "special_requests",
  message: "special_requests",
  comment: "special_requests",
  comments: "special_requests",
  reason: "cancellation_reason",
  cancellationReason: "reason",
  cancellation_reason: "reason",
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
  events: z.array(EventItemSchema),
});

export * from "./bridge";

// Phase 6: Event Schema Registry (Nervous System Hardening)
export * from "./schemas/event-registry";

// ============================================================================
// STRICTLY TYPED TOOL REGISTRY - ELIMINATES ALL `any` TYPES
// Uses Zod's infer capability for type-safe tool execution
// ============================================================================

/**
 * Helper type to extract input type from a Zod schema
 * Usage: ZodInfer<typeof SomeSchema>
 */
export type ZodInfer<T extends zod.ZodType> = zod.infer<T>;

/**
 * Map of all tool names to their Zod schemas
 * This is the source of truth for type-safe tool execution
 */
export interface AllToolsMap {
  // TableStack
  getAvailability: typeof GetAvailabilitySchema;
  bookTable: typeof BookTableSchema;
  getLiveOperationalState: typeof GetLiveOperationalStateSchema;
  // Table Management
  get_table_availability: typeof GetTableAvailabilitySchema;
  get_table_layout: typeof GetTableLayoutSchema;
  get_reservation: typeof GetReservationSchema;
  list_reservations: typeof ListReservationsSchema;
  check_table_conflicts: typeof CheckTableConflictsSchema;
  create_reservation: typeof CreateReservationSchema;
  update_reservation: typeof UpdateReservationSchema;
  cancel_reservation: typeof CancelReservationSchema;
  add_to_waitlist: typeof AddToWaitlistSchema;
  update_waitlist_status: typeof UpdateWaitlistStatusSchema;
  validate_reservation: typeof ValidateReservationSchema;
  // OpenDelivery
  calculateQuote: typeof CalculateQuoteSchema;
  getDriverLocation: typeof GetDriverLocationSchema;
  // Delivery Fulfillment
  calculate_delivery_quote: typeof CalculateDeliveryQuoteSchema;
  fulfill_intent: typeof IntentFulfillmentSchema;
  get_fulfillment_status: typeof GetFulfillmentStatusSchema;
  cancel_fulfillment: typeof CancelFulfillmentSchema;
  update_fulfillment: typeof UpdateFulfillmentSchema;
  validate_fulfillment: typeof ValidateFulfillmentSchema;
  // Mobility
  request_ride: typeof MobilityRequestSchema;
  get_route_estimate: typeof RouteEstimateSchema;
  // Booking
  reserve_restaurant: typeof TableReservationSchema;
  // Communication
  send_comm: typeof CommunicationSchema;
  // Context
  get_weather_data: typeof WeatherDataSchema;
  // Parallel Execution
  resolve_dependencies: typeof DependencyResolverInputSchema;
  execute_parallel: typeof ParallelExecutionSchema;
}

/**
 * Type for tool input parameters - strictly inferred from Zod schema
 * NO MORE `any` - parameters are now type-safe based on tool name
 */
export type ToolInput<TToolName extends keyof AllToolsMap = keyof AllToolsMap> =
  TToolName extends keyof AllToolsMap
    ? zod.infer<AllToolsMap[TToolName]>
    : never;

/**
 * Type for tool output (remains flexible as outputs vary)
 */
export type ToolOutput = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

/**
 * Typed tool executor interface
 * Ensures execute() is strictly typed to the Zod schema associated with that tool name
 *
 * @example
 * const executor: TypedToolExecutor = { ... };
 * // TypeScript will enforce that parameters match the schema for 'bookTable'
 * await executor.execute('bookTable', { restaurantId, tableId, guestName, guestEmail, partySize, startTime });
 */
export interface TypedToolExecutor {
  execute<TToolName extends keyof AllToolsMap>(
    toolName: TToolName,
    parameters: ToolInput<TToolName>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{
    success: boolean;
    output?: unknown;
    error?: string;
    latency_ms: number;
    compensation?: {
      toolName: string;
      parameters?: Record<string, unknown>;
    };
  }>;
}

/**
 * Tool definition with strictly typed schema
 */
export interface ToolDefinition<TSchema extends zod.ZodType> {
  name: string;
  description: string;
  schema: TSchema;
  requires_confirmation?: boolean;
}

/**
 * Type-safe tool registry entry
 */
export interface TypedToolEntry<TToolName extends keyof AllToolsMap> {
  name: TToolName;
  description: string;
  schema: AllToolsMap[TToolName];
  requires_confirmation?: boolean;
}

/**
 * Helper type to extract tool name from a tool definition
 */
type ExtractToolName<T> = T extends { name: infer N } ? N : never;

/**
 * Helper type to get all tool names from the registry
 */
type AllToolNames = {
  [K1 in keyof McpToolRegistry]: {
    [K2 in keyof McpToolRegistry[K1]]: ExtractToolName<McpToolRegistry[K1][K2]>;
  }[keyof McpToolRegistry[K1]];
}[keyof McpToolRegistry];

/**
 * Helper function to get typed tool entry
 * Provides type-safe access to tool definitions
 */
export function getTypedToolEntry<TToolName extends keyof AllToolsMap>(
  toolName: TToolName,
): TypedToolEntry<TToolName> | undefined {
  // Search through TOOLS registry using type-safe iteration
  const categories = Object.keys(TOOLS) as Array<keyof typeof TOOLS>;

  for (const category of categories) {
    const categoryTools = TOOLS[category] as Record<
      string,
      { name: string; description: string; schema: zod.ZodType }
    >;
    const toolKeys = Object.keys(categoryTools);

    for (const key of toolKeys) {
      const tool = categoryTools[key];
      if (tool.name === toolName) {
        return tool as unknown as TypedToolEntry<TToolName>;
      }
    }
  }
  return undefined;
}

/**
 * Helper function to validate tool parameters at runtime with strict typing
 * Returns validated parameters or throws ZodError
 */
export function validateToolParams<TToolName extends keyof AllToolsMap>(
  toolName: TToolName,
  params: unknown,
): ToolInput<TToolName> {
  const tool = getTypedToolEntry(toolName);
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  return tool.schema.parse(params) as ToolInput<TToolName>;
}

/**
 * Generate a schema hash for version-pinned checkpoints
 * Used to detect schema evolution during saga execution
 */
export async function generateSchemaHash(schema: zod.ZodType): Promise<string> {
  // Serialize schema to JSON string (Zod schemas have toJSON())
  const schemaJson = JSON.stringify(schema._def);

  // Generate SHA-256 hash
  const encoder = new TextEncoder();
  const data = encoder.encode(schemaJson);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return hashHex.substring(0, 16); // Use 16 chars for brevity
}
