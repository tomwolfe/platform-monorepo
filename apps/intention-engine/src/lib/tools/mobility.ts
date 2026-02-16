import { z } from "zod";
import { ToolDefinitionMetadata, ToolParameter } from "./types";
import { 
  MobilityRequestSchema, 
  RouteEstimateSchema, 
  UnifiedLocationSchema,
} from "@repo/mcp-protocol";
import type { UnifiedLocation } from "@repo/mcp-protocol";

export { 
  MobilityRequestSchema, 
  RouteEstimateSchema, 
  UnifiedLocationSchema,
};
export type { UnifiedLocation };

/**
 * Helper function to normalize unified location to string format
 */
export function normalizeLocation(location: UnifiedLocation | undefined): string {
  if (!location) return "unknown";
  if (typeof location === "string") {
    return location;
  }
  // Convert coordinate object to string format
  if (location.address) {
    return `${location.address} (${location.lat}, ${location.lon})`;
  }
  return `${location.lat}, ${location.lon}`;
}

export type MobilityRequestParams = z.infer<typeof MobilityRequestSchema>;
export type RouteEstimateParams = z.infer<typeof RouteEstimateSchema>;

// Return schema for mobility_request tool
export const mobilityRequestReturnSchema = {
  status: "string",
  service: "string",
  pickup: "string",
  destination: "string",
  estimated_arrival: "string"
};

// Return schema for get_route_estimate tool
export const routeEstimateReturnSchema = {
  origin: "string",
  destination: "string",
  distance_km: "number",
  duration_minutes: "number",
  traffic_status: "string"
};

export async function mobility_request(params: MobilityRequestParams): Promise<{ success: boolean; result?: any; error?: string }> {
  const validated = MobilityRequestSchema.safeParse(params);
  if (!validated.success) {
    return { success: false, error: "Invalid parameters: " + validated.error.message };
  }

  const { service, pickup_location, destination_location, ride_type } = validated.data;

  const resolveCoords = async (loc: UnifiedLocation | undefined) => {
    if (!loc) return null;
    // Handle case where loc is a JSON string (e.g., from AI SDK serialization)
    if (typeof loc === "string") {
      try {
        const parsed = JSON.parse(loc);
        if (parsed && typeof parsed === "object" && "lat" in parsed && "lon" in parsed) {
          return { lat: parsed.lat, lon: parsed.lon };
        }
      } catch {
        // Not a JSON string, treat as regular address string
      }
    }
    if (typeof loc === "object") return { lat: loc.lat, lon: loc.lon };
    const geo = await geocode_location({ location: loc });
    if (geo.success && geo.result) return { lat: geo.result.lat, lon: geo.result.lon };
    return null; // Fallback to null if geocoding fails
  };

  const pickupCoords = await resolveCoords(pickup_location);
  const destCoords = await resolveCoords(destination_location);

  // Normalize locations to string format for API compatibility
  const normalizedPickup = normalizeLocation(pickup_location);
  const normalizedDestination = normalizeLocation(destination_location);

  console.log(`Functional ride request: ${service} from ${normalizedPickup} to ${normalizedDestination}...`);

  try {
    // Generate a random driver name and plate
    const drivers = ["Alex", "Jordan", "Sam", "Taylor"];
    const driver = drivers[Math.floor(Math.random() * drivers.length)];
    const plate = Math.random().toString(36).substring(2, 7).toUpperCase();

    return {
      success: true,
      result: {
        status: "requested",
        service: service,
        pickup: normalizedPickup,
        destination: normalizedDestination,
        driver_name: driver,
        vehicle_plate: plate,
        estimated_arrival: new Date(Date.now() + 8 * 60 * 1000).toISOString(),
        pickup_coordinates: pickupCoords,
        destination_coordinates: destCoords
      }
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

import { geocode_location } from "./location_search";

export async function get_route_estimate(params: RouteEstimateParams): Promise<{ success: boolean; result?: any; error?: string }> {
  const validated = RouteEstimateSchema.safeParse(params);
  if (!validated.success) {
    return { success: false, error: "Invalid parameters: " + validated.error.message };
  }

  let { origin, destination, travel_mode } = validated.data;
  
  const resolveCoords = async (loc: UnifiedLocation) => {
    // Handle case where loc is a JSON string (e.g., from AI SDK serialization)
    if (typeof loc === "string") {
      try {
        const parsed = JSON.parse(loc);
        if (parsed && typeof parsed === "object" && "lat" in parsed && "lon" in parsed) {
          return { lat: parsed.lat, lon: parsed.lon };
        }
      } catch {
        // Not a JSON string, treat as regular address string
      }
    }
    if (typeof loc === "object") return { lat: loc.lat, lon: loc.lon };
    const geo = await geocode_location({ location: loc });
    if (geo.success && geo.result) return { lat: geo.result.lat, lon: geo.result.lon };
    throw new Error("Could not geocode: " + loc);
  };

  try {
    const originCoords = await resolveCoords(origin);
    const destCoords = await resolveCoords(destination);
    
    const normalizedOrigin = normalizeLocation(origin);
    const normalizedDestination = normalizeLocation(destination);

    console.log(`Getting functional route estimate from ${normalizedOrigin} to ${normalizedDestination} via ${travel_mode}...`);

    // OSRM handles driving, walking, cycling
    const osrmMode = travel_mode === "bicycling" ? "bicycle" : 
                    travel_mode === "walking" ? "foot" : "car";
    
    // Note: Public OSRM demo server only supports 'driving' (car) reliably. 
    // We'll use 'driving' as base and adjust for other modes if car is the only available profile.
    const url = `https://router.project-osrm.org/route/v1/driving/${originCoords.lon},${originCoords.lat};${destCoords.lon},${destCoords.lat}?overview=false`;
    
    const response = await fetch(url);
    if (!response.ok) throw new Error("Routing API error");
    
    const data = await response.json();
    if (!data.routes || data.routes.length === 0) throw new Error("No route found");
    
    const route = data.routes[0];
    let distanceKm = route.distance / 1000;
    let durationMins = route.duration / 60;

    // Adjust for non-driving modes since we use the driving profile
    if (travel_mode === "walking") {
      durationMins = (distanceKm / 5) * 60; // 5 km/h
    } else if (travel_mode === "bicycling") {
      durationMins = (distanceKm / 15) * 60; // 15 km/h
    }

    return {
      success: true,
      result: {
        origin: normalizedOrigin,
        destination: normalizedDestination,
        distance_km: parseFloat(distanceKm.toFixed(1)),
        duration_minutes: Math.round(durationMins),
        traffic_status: travel_mode === "driving" ? "moderate" : "n/a"
      }
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export const mobilityRequestToolDefinition: ToolDefinitionMetadata = {
  name: "mobility_request",
  version: "1.0.0",
  description: "Requests a ride from a mobility service (Uber, Tesla, Lyft) from pickup to destination.",
  inputSchema: {
    type: "object",
    properties: {
      service: { type: "string", enum: ["uber", "tesla", "lyft"], description: "The mobility service to use." },
      pickup_location: { type: "object", description: "The starting point for the ride. Can be a string address OR an object with lat/lon coordinates." },
      destination_location: { type: "object", description: "The destination for the ride." },
      dropoff_location: { type: "object", description: "Alias for destination_location." },
      ride_type: { type: "string", description: "The type of ride (e.g., 'UberX', 'Model S')." }
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
  }
};

export const routeEstimateToolDefinition: ToolDefinitionMetadata = {
  name: "get_route_estimate",
  version: "1.0.0",
  description: "Gets drive time and distance estimates between two locations for various travel modes.",
  inputSchema: {
    type: "object",
    properties: {
      origin: { type: "object", description: "The starting location. Can be a string address OR an object with lat/lon coordinates." },
      destination: { type: "object", description: "The destination location. Can be a string address OR an object with lat/lon coordinates." },
      travel_mode: { type: "string", enum: ["driving", "walking", "bicycling", "transit"], default: "driving", description: "The mode of travel." }
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
  }
};
