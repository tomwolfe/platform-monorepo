import { z } from "zod";
import { ToolDefinitionMetadata, ToolParameter } from "./types";
import {
  MobilityRequestSchema,
  RouteEstimateSchema,
  UnifiedLocationSchema,
} from "@repo/mcp-protocol";
import type { UnifiedLocation } from "@repo/mcp-protocol";
import { withNervousSystemTracing, injectTracingHeaders } from "@repo/shared/tracing";
import {
  getMobilityProvider,
  validateMobilityRequest,
  type MobilityRequest,
} from "@repo/shared/services/mobility-provider";

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

// Return schema for cancel_ride tool
export const cancelRideReturnSchema = {
  status: "string",
  ride_id: "string",
  cancellation_time: "string",
  refund_amount: "number"
};

/**
 * Request a ride using the configured mobility provider
 * Uses dependency injection for testability
 */
export async function mobility_request(params: MobilityRequestParams): Promise<{ success: boolean; result?: any; error?: string }> {
  const validated = MobilityRequestSchema.safeParse(params);
  if (!validated.success) {
    return { success: false, error: "Invalid parameters: " + validated.error.message };
  }

  try {
    // Use provider abstraction for ride request
    const provider = getMobilityProvider(validated.data.service);
    const mobilityRequest: MobilityRequest = validateMobilityRequest(validated.data);
    const result = await provider.requestRide(mobilityRequest);

    return {
      success: result.status !== "failed",
      result,
      error: result.error,
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Cancel a ride request
 *
 * Compensation for request_ride / mobility_request
 * Automatically called by saga orchestrator when a ride needs to be cancelled
 * (e.g., restaurant booking failed after ride was requested)
 */
export async function cancel_ride(params: { ride_id?: string; service?: string; pickup_location?: string; destination_location?: string }): Promise<{ success: boolean; result?: any; error?: string }> {
  try {
    // Use provider abstraction for ride cancellation
    const service = params.service as "uber" | "lyft" | "tesla" | "waymo" | undefined;
    const provider = getMobilityProvider(service);
    const result = await provider.cancelRide({
      ride_id: params.ride_id,
      service,
      pickup_location: params.pickup_location,
      destination_location: params.destination_location,
    });

    return {
      success: result.status === "cancelled",
      result,
      error: result.error,
    };
  } catch (error: any) {
    return {
      success: false,
      error: `Failed to cancel ride: ${error.message}`
    };
  }
}

import { geocode_location } from "./location_search";

/**
 * Calculate distance between two coordinates using Haversine formula
 * Returns distance in kilometers
 */
function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculate estimated duration based on distance and travel mode
 * Returns duration in minutes
 */
function estimateDuration(distanceKm: number, travelMode: string): number {
  const speeds: Record<string, number> = {
    driving: 40, // km/h (urban average)
    walking: 5,
    bicycling: 15,
    transit: 30,
  };
  const speed = speeds[travelMode] || speeds.driving;
  return Math.round((distanceKm / speed) * 60);
}

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

    // CI/TEST MODE: Use Haversine fallback for deterministic, offline-safe testing
    if (process.env.CI === 'true' || process.env.NODE_ENV === 'test') {
      console.log('[get_route_estimate] CI/Test mode detected - using Haversine fallback');
      return getHaversineFallback(normalizedOrigin, normalizedDestination, originCoords, destCoords, travel_mode);
    }

    // OSRM handles driving, walking, cycling
    const osrmMode = travel_mode === "bicycling" ? "bicycle" :
                    travel_mode === "walking" ? "foot" : "car";

    // Note: Public OSRM demo server only supports 'driving' (car) reliably.
    // We'll use 'driving' as base and adjust for other modes if car is the only available profile.
    const url = `https://router.project-osrm.org/route/v1/driving/${originCoords.lon},${originCoords.lat};${destCoords.lon},${destCoords.lat}?overview=false`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    return await withNervousSystemTracing(async ({ correlationId }) => {
      let response: Response;

      try {
        response = await fetch(url, {
          headers: injectTracingHeaders({}, correlationId),
          signal: controller.signal
        });
      } catch (fetchError: any) {
        clearTimeout(timeoutId);

        // Handle AbortError (timeout) or network errors - FALLBACK TO HAVERSINE
        if (fetchError.name === 'AbortError' || fetchError.message?.includes('fetch')) {
          console.warn('[get_route_estimate] OSRM API timeout, using Haversine fallback');
          return getHaversineFallback(normalizedOrigin, normalizedDestination, originCoords, destCoords, travel_mode);
        }

        throw fetchError;
      }

      clearTimeout(timeoutId);

      // Handle HTTP error status codes
      if (!response.ok) {
        const statusCode = response.status;

        // Handle rate limiting (429) or service unavailable (503) - FALLBACK TO HAVERSINE
        if (statusCode === 429 || statusCode === 503 || statusCode >= 500) {
          console.warn(`[get_route_estimate] OSRM API ${statusCode}, using Haversine fallback`);
          return getHaversineFallback(normalizedOrigin, normalizedDestination, originCoords, destCoords, travel_mode);
        }

        // For other errors (400, 404), try Haversine as fallback
        console.warn(`[get_route_estimate] OSRM API error ${statusCode}, using Haversine fallback`);
        return getHaversineFallback(normalizedOrigin, normalizedDestination, originCoords, destCoords, travel_mode);
      }

      const data = await response.json();
      if (!data.routes || data.routes.length === 0) {
        // No route found - use Haversine fallback
        console.warn('[get_route_estimate] No route found, using Haversine fallback');
        return getHaversineFallback(normalizedOrigin, normalizedDestination, originCoords, destCoords, travel_mode);
      }

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
    });
  } catch (error: any) {
    // Final fallback: return Haversine-based estimate
    console.warn('[get_route_estimate] OSRM failed, using Haversine fallback:', error.message);
    try {
      const originCoords = await resolveCoords(origin);
      const destCoords = await resolveCoords(destination);
      const normalizedOrigin = normalizeLocation(origin);
      const normalizedDestination = normalizeLocation(destination);

      return getHaversineFallback(normalizedOrigin, normalizedDestination, originCoords, destCoords, travel_mode);
    } catch (fallbackError: any) {
      return { success: false, error: error.message };
    }
  }
}

/**
 * Haversine-based fallback for route estimation
 * Returns straight-line distance estimate when OSRM is unavailable
 */
async function getHaversineFallback(
  normalizedOrigin: string,
  normalizedDestination: string,
  originCoords: { lat: number; lon: number },
  destCoords: { lat: number; lon: number },
  travelMode: string
): Promise<{ success: boolean; result: any }> {
  const distanceKm = haversineDistance(
    originCoords.lat,
    originCoords.lon,
    destCoords.lat,
    destCoords.lon
  );
  
  const durationMins = estimateDuration(distanceKm, travelMode);
  
  console.log(
    `[get_route_estimate] Haversine fallback: ${distanceKm.toFixed(1)}km, ~${durationMins}min (${travelMode})`
  );

  return {
    success: true,
    result: {
      origin: normalizedOrigin,
      destination: normalizedDestination,
      distance_km: parseFloat(distanceKm.toFixed(1)),
      duration_minutes: durationMins,
      traffic_status: "n/a",
      warning: 'Using straight-line estimate (OSRM unavailable). Actual route may differ.',
      method: 'haversine',
    },
  };
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
