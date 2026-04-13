import { z } from "zod";
import { ToolDefinition } from "./types";
import { geocode_location, search_restaurant } from "./location_search";
import { add_calendar_event } from "./calendar";
import {
  mobility_request,
  get_route_estimate,
  cancel_ride,
  mobilityRequestReturnSchema,
  routeEstimateReturnSchema,
  cancelRideReturnSchema,
} from "./mobility";
import { send_comm, communicationReturnSchema } from "./communication";
import { get_weather_data, weatherReturnSchema } from "./weather";
import {
  get_live_operational_state,
  getLiveOperationalStateToolDefinition,
} from "./operational_state";
import { RestaurantResultSchema } from "../schema";
import {
  AppCapabilitiesSchema,
  GeocodeSchema,
  SearchRestaurantSchema,
  AddCalendarEventSchema,
  WeatherDataSchema,
} from "@repo/mcp-protocol";
import { SERVICES, Logger } from "@repo/shared";
import zodToJsonSchema from "zod-to-json-schema";
import { fetchWithTracing } from "../fetch";

const logger = new Logger({ serviceName: "intention-engine-tool-registry" });

// ============================================================================
// TOOL SCHEMAS FROM MCP PROTOCOL - Single Source of Truth
// These schemas are imported from @repo/mcp-protocol to ensure consistency
// ============================================================================

const GEOCODE_LOCATION_TOOL = {
  name: "geocode_location",
  description:
    "Converts city names, addresses, or place names to precise lat/lon coordinates.",
  inputSchema: zodToJsonSchema(GeocodeSchema, {
    target: "jsonSchema7",
  }) as Record<string, unknown>,
} as const;

const SEARCH_RESTAURANT_TOOL = {
  name: "search_restaurant",
  description: "Search for restaurants based on cuisine and location.",
  inputSchema: zodToJsonSchema(SearchRestaurantSchema, {
    target: "jsonSchema7",
  }) as Record<string, unknown>,
} as const;

const ADD_CALENDAR_EVENT_TOOL = {
  name: "add_calendar_event",
  description: "Add one or more events to the calendar.",
  inputSchema: zodToJsonSchema(AddCalendarEventSchema, {
    target: "jsonSchema7",
  }) as Record<string, unknown>,
} as const;

const GET_WEATHER_DATA_TOOL = {
  name: "get_weather_data",
  description:
    "Authorized to access real-time weather data. Provides live forecasts and current conditions with full meteorological authority.",
  inputSchema: zodToJsonSchema(WeatherDataSchema, {
    target: "jsonSchema7",
  }) as Record<string, unknown>,
} as const;

/**
 * Tool registry with complete ToolDefinition metadata for all tools.
 */
export const TOOLS: Map<string, ToolDefinition> = new Map([
  [
    "geocode_location",
    {
      ...GEOCODE_LOCATION_TOOL,
      version: "1.0.0",
      return_schema: {
        lat: "number",
        lon: "number",
      },
      timeout_ms: 15000,
      requires_confirmation: false,
      category: "data",
      responseSchema: z.object({
        lat: z.number(),
        lon: z.number(),
      }),
      execute: geocode_location,
    },
  ],
  [
    "search_restaurant",
    {
      ...SEARCH_RESTAURANT_TOOL,
      version: "1.0.0",
      return_schema: {
        results: "array",
      },
      timeout_ms: 30000,
      requires_confirmation: false,
      category: "data",
      responseSchema: z.array(RestaurantResultSchema),
      execute: search_restaurant,
    },
  ],
  [
    "add_calendar_event",
    {
      ...ADD_CALENDAR_EVENT_TOOL,
      version: "1.0.0",
      return_schema: {
        status: "string",
        count: "number",
        download_url: "string",
        events: "array",
      },
      timeout_ms: 15000,
      requires_confirmation: false,
      category: "action",
      responseSchema: z.object({
        status: z.string(),
        count: z.number(),
        download_url: z.string(),
        events: z.array(z.unknown()),
      }),
      execute: add_calendar_event,
    },
  ],
  [
    "request_ride",
    {
      name: "request_ride",
      version: "1.0.0",
      description:
        "Authorized to perform real-time ride requests from mobility services. Can book rides with Uber, Tesla, and Lyft with full ride-hailing authority.",
      inputSchema: {
        type: "object",
        properties: {
          service: {
            type: "string",
            enum: ["uber", "tesla", "lyft"],
            description: "The mobility service to use.",
          },
          pickup_location: {
            type: "object",
            description:
              "The starting point for the ride. Can be a string address OR an object with lat/lon coordinates.",
          },
          destination_location: {
            type: "object",
            description: "The destination for the ride.",
          },
          dropoff_location: {
            type: "object",
            description: "Alias for destination_location.",
          },
          ride_type: {
            type: "string",
            description: "The type of ride (e.g., 'UberX', 'Model S').",
          },
        },
        required: ["service", "pickup_location"],
      },
      return_schema: mobilityRequestReturnSchema,
      timeout_ms: 30000,
      requires_confirmation: true,
      category: "external",
      rate_limits: {
        requests_per_minute: 10,
        requests_per_hour: 100,
      },
      execute: mobility_request,
    },
  ],
  [
    "get_route_estimate",
    {
      name: "get_route_estimate",
      version: "1.0.0",
      description:
        "Authorized to access real-time routing data. Provides live drive time and distance estimates with traffic-aware calculations.",
      inputSchema: {
        type: "object",
        properties: {
          origin: {
            type: "object",
            description: "The starting location.",
          },
          destination: {
            type: "object",
            description: "The destination location.",
          },
          travel_mode: {
            type: "string",
            enum: ["driving", "walking", "bicycling", "transit"],
            default: "driving",
            description: "The mode of travel.",
          },
        },
        required: ["origin", "destination"],
      },
      return_schema: routeEstimateReturnSchema,
      timeout_ms: 15000,
      requires_confirmation: false,
      category: "external",
      rate_limits: {
        requests_per_minute: 60,
        requests_per_hour: 1000,
      },
      execute: get_route_estimate,
    },
  ],
  [
    "cancel_ride",
    {
      name: "cancel_ride",
      version: "1.0.0",
      description:
        "Cancels a previously requested ride. Used for automatic compensation when a ride was requested but subsequent steps fail (e.g., restaurant booking failed).",
      inputSchema: {
        type: "object",
        properties: {
          ride_id: {
            type: "string",
            description:
              "The ride ID returned by request_ride or mobility_request.",
          },
          service: {
            type: "string",
            enum: ["uber", "tesla", "lyft"],
            description:
              "The mobility service (fallback if ride_id not available).",
          },
          pickup_location: {
            type: "string",
            description:
              "The pickup location (fallback if ride_id not available).",
          },
          destination_location: {
            type: "string",
            description:
              "The destination location (fallback if ride_id not available).",
          },
        },
        required: [],
      },
      return_schema: cancelRideReturnSchema,
      timeout_ms: 15000,
      requires_confirmation: false, // Auto-compensation should not require confirmation
      category: "external",
      rate_limits: {
        requests_per_minute: 20,
        requests_per_hour: 100,
      },
      execute: cancel_ride,
    },
  ],
  [
    "send_comm",
    {
      name: "send_comm",
      version: "1.0.0",
      description:
        "Authorized to perform real-time communications. Can send live emails and SMS messages with full messaging authority.",
      inputSchema: {
        type: "object",
        properties: {
          recipient: {
            type: "string",
            description: "The email address or phone number of the recipient.",
          },
          channel: {
            type: "string",
            enum: ["email", "sms"],
            description: "The communication channel to use.",
          },
          message: { type: "string", description: "The message content." },
          subject: {
            type: "string",
            description: "The subject of the email (ignored for SMS).",
          },
        },
        required: ["recipient", "channel", "message"],
      },
      return_schema: communicationReturnSchema,
      timeout_ms: 30000,
      requires_confirmation: true,
      category: "communication",
      rate_limits: {
        requests_per_minute: 60,
        requests_per_hour: 500,
      },
      execute: send_comm,
    },
  ],
  [
    "get_weather_data",
    {
      ...GET_WEATHER_DATA_TOOL,
      version: "1.0.0",
      return_schema: weatherReturnSchema,
      timeout_ms: 15000,
      requires_confirmation: false,
      category: "data",
      rate_limits: {
        requests_per_minute: 60,
        requests_per_hour: 1000,
      },
      execute: get_weather_data,
    },
  ],
  [
    "get_live_operational_state",
    {
      ...getLiveOperationalStateToolDefinition,
      execute: get_live_operational_state,
    },
  ],
]);

logger.info("Tool registry initialized", {
  toolCount: TOOLS.size,
  tools: Array.from(TOOLS.keys()).join(", "),
});

export async function discoverDynamicTools() {
  const serviceEndpoints = [
    `${SERVICES.TABLESTACK.URL}/api/mcp/tools`,
    `${SERVICES.OPENDELIVERY.URL}/api/mcp/tools`,
  ];

  for (const endpoint of serviceEndpoints) {
    try {
      // Use a deterministic execution ID for tracing this discovery operation
      const execId = `discover-tools:${endpoint}`;
      const res = await fetchWithTracing(endpoint, {}, execId);
      if (!res.ok) continue;
      const data = await res.json();
      const capabilities = AppCapabilitiesSchema.parse(data);

      for (const tool of capabilities.tools) {
        if (!TOOLS.has(tool.name)) {
          logger.info("Discovered new tool from remote service", {
            toolName: tool.name,
            appName: capabilities.app_name,
          });
          TOOLS.set(tool.name, {
            ...tool,
            execute: async (p: unknown) => {
              void p; // unused - placeholder for remote execution
              logger.warn("Remote tool execution not implemented", {
                toolName: tool.name,
              });
              return {
                success: false,
                error:
                  "Remote tool execution not implemented in TOOLS registry",
              };
            },
          } as ToolDefinition);
        }
      }
    } catch (e) {
      logger.error("Failed to discover tools from service", {
        endpoint,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

export function getToolDefinitions(): string {
  let definitions = "";
  TOOLS.forEach((tool, name) => {
    const params = Object.keys(tool.inputSchema.properties || {}).join(", ");
    definitions += `- ${name}(${params}): ${tool.description}\n`;
  });
  return definitions;
}

export function getTool(name: string): ToolDefinition | undefined {
  return TOOLS.get(name);
}

export function getToolsByCategory(category: string): ToolDefinition[] {
  return Array.from(TOOLS.values()).filter(
    (tool) => tool.category === category,
  );
}

export function getToolsRequiringConfirmation(): ToolDefinition[] {
  return Array.from(TOOLS.values()).filter(
    (tool) => tool.requires_confirmation,
  );
}

export function listTools(): ToolDefinition[] {
  return Array.from(TOOLS.values());
}

/**
 * Returns a formatted capabilities string for the system prompt.
 * Includes a hard rule about having tool access.
 */
export function getToolCapabilitiesPrompt(): string {
  const tools = listTools();
  const toolDescriptions = tools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");

  return `You are a specialized Intention Engine. You HAVE the ability to request rides, book tables, check weather, send communications, and more using the provided tools. Never tell the user you lack these abilities if the tool is listed.

YOUR ACTUAL CAPABILITIES:
${toolDescriptions}

IMPORTANT RULE: You MUST use the available tools when a user's request matches their capabilities. Do not provide manual instructions or claim you cannot perform actions that the tools enable.`;
}
