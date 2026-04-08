import { z } from "zod";
import { ToolDefinitionMetadata, ToolParameter } from "./types";
import {
  MobilityRequestSchema,
  RouteEstimateSchema,
  UnifiedLocationSchema,
} from "@repo/mcp-protocol";
import type { UnifiedLocation } from "@repo/mcp-protocol";
import {
  withNervousSystemTracing,
  injectTracingHeaders,
} from "@repo/shared/tracing";
import {
  getMobilityProvider,
  validateMobilityRequest,
  type MobilityRequest,
} from "@repo/shared/services/mobility-provider";
import {
  AppConfig,
  CircuitBreaker,
  CircuitBreakerOpenError,
} from "@repo/shared";

export { MobilityRequestSchema, RouteEstimateSchema, UnifiedLocationSchema };
export type { UnifiedLocation };

/**
 * Circuit breakers for external routing providers
 * Prevents cascade failures when services are down
 */
const openRouteServiceBreaker = new CircuitBreaker("openrouteservice", {
  failureThreshold: 3,
  resetTimeoutMs: 60000, // 1 minute
  successThreshold: 2,
  requestTimeoutMs: AppConfig.getOrsRoutingTimeoutMs(),
});

const osrmBreaker = new CircuitBreaker("osrm-public", {
  failureThreshold: 3,
  resetTimeoutMs: 30000, // 30 seconds
  successThreshold: 2,
  requestTimeoutMs: 8000,
});

/**
 * Helper function to normalize unified location to string format
 */
export function normalizeLocation(
  location: UnifiedLocation | undefined,
): string {
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
  estimated_arrival: "string",
};

// Return schema for get_route_estimate tool
export const routeEstimateReturnSchema = {
  origin: "string",
  destination: "string",
  distance_km: "number",
  duration_minutes: "number",
  traffic_status: "string",
};

// Return schema for cancel_ride tool
export const cancelRideReturnSchema = {
  status: "string",
  ride_id: "string",
  cancellation_time: "string",
  refund_amount: "number",
};

/**
 * Request a ride using the configured mobility provider
 * Uses dependency injection for testability
 */
export async function mobility_request(
  params: MobilityRequestParams,
): Promise<{ success: boolean; result?: any; error?: string }> {
  const validated = MobilityRequestSchema.safeParse(params);
  if (!validated.success) {
    return {
      success: false,
      error: "Invalid parameters: " + validated.error.message,
    };
  }

  try {
    // Use provider abstraction for ride request
    const provider = getMobilityProvider(validated.data.service);
    const mobilityRequest: MobilityRequest = validateMobilityRequest(
      validated.data,
    );
    const result = await provider.requestRide(mobilityRequest);

    return {
      success: result.status !== "failed",
      result,
      error: result.error,
    };
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Cancel a ride request
 *
 * Compensation for request_ride / mobility_request
 * Automatically called by saga orchestrator when a ride needs to be cancelled
 * (e.g., restaurant booking failed after ride was requested)
 */
export async function cancel_ride(params: {
  ride_id?: string;
  service?: string;
  pickup_location?: string;
  destination_location?: string;
}): Promise<{ success: boolean; result?: any; error?: string }> {
  try {
    // Use provider abstraction for ride cancellation
    const service = params.service as
      | "uber"
      | "lyft"
      | "tesla"
      | "waymo"
      | undefined;
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
  } catch (error: unknown) {
    return {
      success: false,
      error: `Failed to cancel ride: ${error instanceof Error ? error.message : String(error)}`,
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
  lon2: number,
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

/**
 * Fetch wrapper with AbortController timeout support
 */
async function fetchWithFallback(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function get_route_estimate(
  params: RouteEstimateParams,
): Promise<{ success: boolean; result?: any; error?: string }> {
  const validated = RouteEstimateSchema.safeParse(params);
  if (!validated.success) {
    return {
      success: false,
      error: "Invalid parameters: " + validated.error.message,
    };
  }

  const { origin, destination, travel_mode } = validated.data;

  const resolveCoords = async (loc: UnifiedLocation) => {
    // Handle case where loc is a JSON string (e.g., from AI SDK serialization)
    if (typeof loc === "string") {
      try {
        const parsed = JSON.parse(loc);
        if (
          parsed &&
          typeof parsed === "object" &&
          "lat" in parsed &&
          "lon" in parsed
        ) {
          return { lat: parsed.lat, lon: parsed.lon };
        }
      } catch {
        // Not a JSON string, treat as regular address string
      }
    }
    if (typeof loc === "object") return { lat: loc.lat, lon: loc.lon };
    const geo = await geocode_location({ location: loc });
    if (geo.success && geo.result)
      return { lat: geo.result.lat, lon: geo.result.lon };
    throw new Error("Could not geocode: " + loc);
  };

  try {
    const originCoords = await resolveCoords(origin);
    const destCoords = await resolveCoords(destination);

    const normalizedOrigin = normalizeLocation(origin);
    const normalizedDestination = normalizeLocation(destination);

    console.log(
      `Getting functional route estimate from ${normalizedOrigin} to ${normalizedDestination} via ${travel_mode}...`,
    );

    // CI/TEST MODE: Use Haversine fallback for deterministic, offline-safe testing
    if (process.env.CI === "true" || process.env.NODE_ENV === "test") {
      console.log(
        "[get_route_estimate] CI/Test mode detected - using Haversine fallback",
      );
      return getHaversineFallback(
        normalizedOrigin,
        normalizedDestination,
        originCoords,
        destCoords,
        travel_mode,
      );
    }

    // ROUTING FALLBACK CHAIN (100% Free):
    // 1. Primary: OpenRouteService (free tier: ~2,500 req/day)
    //    - Rich metadata: elevation, surface type, way types
    //    - Profiles: driving-car, driving-hgv, foot-walking, cycling-regular
    // 2. Fallback: Public OSRM demo server (unlimited but rate-limited)
    //    - Driving profile only, no metadata
    // 3. Offline: Haversine straight-line distance (always available)
    const orsApiKey = AppConfig.getOpenrouteserviceApiKey();
    const hasOrsKey = !!orsApiKey;

    if (hasOrsKey) {
      console.log("[get_route_estimate] Using OpenRouteService (primary)");
    } else {
      console.log(
        "[get_route_estimate] No ORS API key, falling back to public OSRM",
      );
    }

    // Try primary provider (ORS or OSRM)
    return await withNervousSystemTracing(async ({ correlationId }) => {
      // ---- PRIMARY: OpenRouteService ----
      if (hasOrsKey) {
        const orsProfile =
          travel_mode === "walking"
            ? "foot-walking"
            : travel_mode === "bicycling"
              ? "cycling-regular"
              : travel_mode === "transit"
                ? "driving-car" // ORS doesn't have transit
                : "driving-car";
        const orsUrl = `https://api.openrouteservice.org/v2/directions/${orsProfile}/geojson`;
        const orsBody = {
          coordinates: [
            [originCoords.lon, originCoords.lat],
            [destCoords.lon, destCoords.lat],
          ],
          format: "geojson",
        };
        const orsTimeout = AppConfig.getOrsRoutingTimeoutMs();

        try {
          const orsResponse = await openRouteServiceBreaker.execute(
            async () => {
              return await fetchWithFallback(
                orsUrl,
                {
                  method: "POST",
                  headers: {
                    ...injectTracingHeaders(
                      { "Content-Type": "application/json" },
                      correlationId,
                    ),
                    Authorization: orsApiKey!,
                  },
                  body: JSON.stringify(orsBody),
                },
                orsTimeout,
              );
            },
          );

          if (orsResponse.ok) {
            const data = await orsResponse.json();
            if (data.features && data.features.length > 0) {
              const feature = data.features[0];
              const props = feature.properties;
              const distanceKm = props.summary.distance / 1000;
              const durationMins = Math.round(props.summary.duration / 60);

              return {
                success: true,
                result: {
                  origin: normalizedOrigin,
                  destination: normalizedDestination,
                  distance_km: parseFloat(distanceKm.toFixed(1)),
                  duration_minutes: durationMins,
                  traffic_status: "n/a",
                  provider: "openrouteservice",
                  // Rich ORS metadata when available
                  ascent: props.ascent ? Math.round(props.ascent) : undefined,
                  descent: props.descent
                    ? Math.round(props.descent)
                    : undefined,
                },
              };
            }
          } else {
            const statusCode = orsResponse.status;
            if (statusCode === 429 || statusCode === 403 || statusCode >= 500) {
              console.warn(
                `[get_route_estimate] ORS API ${statusCode}, falling back to OSRM`,
              );
            } else {
              console.warn(
                `[get_route_estimate] ORS API error ${statusCode}, falling back to OSRM`,
              );
            }
          }
        } catch (err) {
          if (err instanceof CircuitBreakerOpenError) {
            console.warn(
              "[get_route_estimate] OpenRouteService circuit is open, falling back to OSRM",
            );
          } else {
            console.warn(
              "[get_route_estimate] ORS request failed, falling back to OSRM:",
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }

      // ---- FALLBACK: Public OSRM ----
      const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${originCoords.lon},${originCoords.lat};${destCoords.lon},${destCoords.lat}?overview=false`;

      try {
        const osrmResponse = await osrmBreaker.execute(async () => {
          return await fetchWithFallback(
            osrmUrl,
            {
              headers: injectTracingHeaders({}, correlationId),
            },
            8000,
          );
        });

        if (osrmResponse.ok) {
          const data = await osrmResponse.json();
          if (data.routes && data.routes.length > 0) {
            const route = data.routes[0];
            const distanceKm = route.distance / 1000;
            let durationMins = route.duration / 60;

            // Adjust for non-driving modes since OSRM only supports driving
            if (travel_mode === "walking") {
              durationMins = (distanceKm / 5) * 60;
            } else if (travel_mode === "bicycling") {
              durationMins = (distanceKm / 15) * 60;
            }

            return {
              success: true,
              result: {
                origin: normalizedOrigin,
                destination: normalizedDestination,
                distance_km: parseFloat(distanceKm.toFixed(1)),
                duration_minutes: Math.round(durationMins),
                traffic_status: travel_mode === "driving" ? "moderate" : "n/a",
                provider: "osrm-public",
              },
            };
          }
        } else {
          console.warn(
            `[get_route_estimate] OSRM API ${osrmResponse.status}, falling back to Haversine`,
          );
        }
      } catch (err) {
        if (err instanceof CircuitBreakerOpenError) {
          console.warn(
            "[get_route_estimate] OSRM circuit is open, falling back to Haversine",
          );
        } else {
          console.warn(
            "[get_route_estimate] OSRM request failed, falling back to Haversine:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // ---- LAST RESORT: Haversine ----
      console.log(
        "[get_route_estimate] All routing providers failed, using Haversine fallback",
      );
      return getHaversineFallback(
        normalizedOrigin,
        normalizedDestination,
        originCoords,
        destCoords,
        travel_mode,
      );
    });
  } catch (error: unknown) {
    // Final fallback: return Haversine-based estimate
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(
      "[get_route_estimate] OSRM failed, using Haversine fallback:",
      errorMessage,
    );
    try {
      const originCoords = await resolveCoords(origin);
      const destCoords = await resolveCoords(destination);
      const normalizedOrigin = normalizeLocation(origin);
      const normalizedDestination = normalizeLocation(destination);

      return getHaversineFallback(
        normalizedOrigin,
        normalizedDestination,
        originCoords,
        destCoords,
        travel_mode,
      );
    } catch (_unknownError) {
      return { success: false, error: errorMessage };
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
  travelMode: string,
): Promise<{ success: boolean; result: any }> {
  const distanceKm = haversineDistance(
    originCoords.lat,
    originCoords.lon,
    destCoords.lat,
    destCoords.lon,
  );

  const durationMins = estimateDuration(distanceKm, travelMode);

  console.log(
    `[get_route_estimate] Haversine fallback: ${distanceKm.toFixed(1)}km, ~${durationMins}min (${travelMode})`,
  );

  return {
    success: true,
    result: {
      origin: normalizedOrigin,
      destination: normalizedDestination,
      distance_km: parseFloat(distanceKm.toFixed(1)),
      duration_minutes: durationMins,
      traffic_status: "n/a",
      warning:
        "Using straight-line estimate (OSRM unavailable). Actual route may differ.",
      method: "haversine",
    },
  };
}

export const mobilityRequestToolDefinition: ToolDefinitionMetadata = {
  name: "mobility_request",
  version: "1.0.0",
  description:
    "Requests a ride from a mobility service (Uber, Tesla, Lyft) from pickup to destination.",
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
};

export const routeEstimateToolDefinition: ToolDefinitionMetadata = {
  name: "get_route_estimate",
  version: "1.0.0",
  description:
    "Gets drive time and distance estimates between two locations for various travel modes.",
  inputSchema: {
    type: "object",
    properties: {
      origin: {
        type: "object",
        description:
          "The starting location. Can be a string address OR an object with lat/lon coordinates.",
      },
      destination: {
        type: "object",
        description:
          "The destination location. Can be a string address OR an object with lat/lon coordinates.",
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
};
