import { z } from "zod";
import { ToolDefinition } from "./types";
import { geocode_location, search_restaurant } from "./location_search";
import { add_calendar_event } from "./calendar";
import { 
  mobility_request, 
  get_route_estimate, 
  mobilityRequestReturnSchema,
  routeEstimateReturnSchema
} from "./mobility";
import { 
  reserve_table, 
  reserve_restaurant,
  tableReservationReturnSchema,
  reserveRestaurantToolDefinition
} from "./booking";
import { 
  send_comm, 
  communicationReturnSchema
} from "./communication";
import {
  get_weather_data,
  weatherReturnSchema
} from "./weather";
import { 
  get_live_operational_state,
  getLiveOperationalStateToolDefinition
} from "./operational_state";
import { RestaurantResultSchema } from "../schema";
import { 
  GEOCODE_LOCATION_TOOL, 
  SEARCH_RESTAURANT_TOOL, 
  ADD_CALENDAR_EVENT_TOOL,
  GET_WEATHER_DATA_TOOL,
  AppCapabilitiesSchema
} from "@repo/mcp-protocol";
import { SERVICES } from "@repo/shared";

/**
 * Tool registry with complete ToolDefinition metadata for all tools.
 */
export const TOOLS: Map<string, ToolDefinition> = new Map([
  ["geocode_location", {
    ...(GEOCODE_LOCATION_TOOL as any),
    version: "1.0.0",
    return_schema: {
      lat: "number",
      lon: "number"
    },
    timeout_ms: 15000,
    requires_confirmation: false,
    category: "data",
    responseSchema: z.object({
      lat: z.number(),
      lon: z.number()
    }),
    execute: geocode_location
  }],
  ["search_restaurant", {
    ...(SEARCH_RESTAURANT_TOOL as any),
    version: "1.0.0",
    return_schema: {
      results: "array"
    },
    timeout_ms: 30000,
    requires_confirmation: false,
    category: "data",
    responseSchema: z.array(RestaurantResultSchema),
    execute: search_restaurant
  }],
  ["add_calendar_event", {
    ...(ADD_CALENDAR_EVENT_TOOL as any),
    version: "1.0.0",
    return_schema: {
      status: "string",
      count: "number",
      download_url: "string",
      events: "array"
    },
    timeout_ms: 15000,
    requires_confirmation: false,
    category: "action",
    responseSchema: z.object({
      status: z.string(),
      count: z.number(),
      download_url: z.string(),
      events: z.array(z.any())
    }),
    execute: add_calendar_event
  }],
  ["request_ride", {
    name: "request_ride",
    version: "1.0.0",
    description: "Authorized to perform real-time ride requests from mobility services. Can book rides with Uber, Tesla, and Lyft with full ride-hailing authority.",
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          enum: ["uber", "tesla", "lyft"],
          description: "The mobility service to use."
        },
        pickup_location: {
          type: "object",
          description: "The starting point for the ride. Can be a string address OR an object with lat/lon coordinates."
        },
        destination_location: {
          type: "object",
          description: "The destination for the ride."
        },
        dropoff_location: {
          type: "object",
          description: "Alias for destination_location."
        },
        ride_type: {
          type: "string",
          description: "The type of ride (e.g., 'UberX', 'Model S')."
        }
      },
      required: ["service", "pickup_location"]
    },
    return_schema: mobilityRequestReturnSchema,
    timeout_ms: 30000,
    requires_confirmation: true,
    category: "external",
    rate_limits: {
      requests_per_minute: 10,
      requests_per_hour: 100
    },
    execute: mobility_request
  }],
  ["get_route_estimate", {
    name: "get_route_estimate",
    version: "1.0.0",
    description: "Authorized to access real-time routing data. Provides live drive time and distance estimates with traffic-aware calculations.",
    inputSchema: {
      type: "object",
      properties: {
        origin: {
          type: "object",
          description: "The starting location."
        },
        destination: {
          type: "object",
          description: "The destination location."
        },
        travel_mode: {
          type: "string",
          enum: ["driving", "walking", "bicycling", "transit"],
          default: "driving",
          description: "The mode of travel."
        }
      },
      required: ["origin", "destination"]
    },
    return_schema: routeEstimateReturnSchema,
    timeout_ms: 15000,
    requires_confirmation: false,
    category: "external",
    rate_limits: {
      requests_per_minute: 60,
      requests_per_hour: 1000
    },
    execute: get_route_estimate
  }],
  ["book_restaurant_table", {
    name: "book_restaurant_table",
    version: "1.0.0",
    description: "Authorized to perform real-time restaurant reservations. Can finalize live table bookings with confirmation codes and full reservation authority.",
    inputSchema: {
      type: "object",
      properties: {
        restaurant_name: { type: "string", description: "The name of the restaurant." },
        restaurant_address: { type: "string", description: "The address of the restaurant." },
        lat: { type: "number", description: "Latitude of the restaurant." },
        lon: { type: "number", description: "Longitude of the restaurant." },
        date: { type: "string", description: "The date of the reservation (ISO 8601 format)." },
        time: { type: "string", description: "The time of the reservation (e.g., '19:00')." },
        party_size: { type: "number", description: "Number of guests." },
        contact_name: { type: "string", description: "The name for the reservation." },
        contact_phone: { type: "string", description: "The contact phone for the reservation." },
        contact_email: { type: "string", description: "The contact email for the reservation." },
        special_requests: { type: "string", description: "Any special requests." },
        is_confirmed: { type: "boolean", description: "Set to true only if the user has explicitly confirmed these details." }
      },
      required: ["restaurant_name", "date", "party_size", "time", "contact_name", "contact_phone"]
    },
    return_schema: tableReservationReturnSchema,
    timeout_ms: 30000,
    requires_confirmation: true,
    category: "action",
    rate_limits: {
      requests_per_minute: 10,
      requests_per_hour: 100
    },
    execute: reserve_table
  }],
  ["reserve_restaurant", {
    ...reserveRestaurantToolDefinition,
    execute: reserve_restaurant
  }],
  ["send_comm", {
    name: "send_comm",
    version: "1.0.0",
    description: "Authorized to perform real-time communications. Can send live emails and SMS messages with full messaging authority.",
    inputSchema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "The email address or phone number of the recipient." },
        channel: { type: "string", enum: ["email", "sms"], description: "The communication channel to use." },
        message: { type: "string", description: "The message content." },
        subject: { type: "string", description: "The subject of the email (ignored for SMS)." }
      },
      required: ["recipient", "channel", "message"]
    },
    return_schema: communicationReturnSchema,
    timeout_ms: 30000,
    requires_confirmation: true,
    category: "communication",
    rate_limits: {
      requests_per_minute: 60,
      requests_per_hour: 500
    },
    execute: send_comm
  }],
  ["get_weather_data", {
    ...(GET_WEATHER_DATA_TOOL as any),
    version: "1.0.0",
    return_schema: weatherReturnSchema,
    timeout_ms: 15000,
    requires_confirmation: false,
    category: "data",
    rate_limits: {
      requests_per_minute: 60,
      requests_per_hour: 1000
    },
    execute: get_weather_data
  }],
  ["get_live_operational_state", {
    ...getLiveOperationalStateToolDefinition,
    execute: get_live_operational_state
  }]
]);

console.log(`[Tool Registry] Initialized with ${TOOLS.size} tools: ${Array.from(TOOLS.keys()).join(", ")}`);

export async function discoverDynamicTools() {
  const serviceEndpoints = [
    `${SERVICES.TABLESTACK.URL}/api/mcp/tools`,
    `${SERVICES.OPENDELIVERY.URL}/api/mcp/tools`,
  ];

  for (const endpoint of serviceEndpoints) {
    try {
      const res = await fetch(endpoint);
      if (!res.ok) continue;
      const data = await res.json();
      const capabilities = AppCapabilitiesSchema.parse(data);
      
      for (const tool of capabilities.tools) {
        if (!TOOLS.has(tool.name)) {
           console.log(`[MCP Discovery] Discovered new tool: ${tool.name} from ${capabilities.app_name}`);
           TOOLS.set(tool.name, {
             ...tool,
             execute: async (params: any) => {
               // This is a placeholder for remote execution if called directly from TOOLS
               console.warn(`Tool ${tool.name} is a discovered remote tool and should be executed via the Engine's MCP client.`);
               return { success: false, error: "Remote tool execution not implemented in TOOLS registry" };
             }
           } as ToolDefinition);
        }
      }
    } catch (e) {
      console.error(`Failed to discover tools from ${endpoint}:`, e);
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
  return Array.from(TOOLS.values()).filter(tool => tool.category === category);
}

export function getToolsRequiringConfirmation(): ToolDefinition[] {
  return Array.from(TOOLS.values()).filter(tool => tool.requires_confirmation);
}

export function listTools(): ToolDefinition[] {
  return Array.from(TOOLS.values());
}
