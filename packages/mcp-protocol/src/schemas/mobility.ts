import { z } from "zod";

/**
 * Unified Location Schema - Accepts both string addresses and coordinate objects
 */
export const UnifiedLocationSchema = z.union([
  z.string().describe("A string address or location name (e.g., '123 Main St', 'Airport', 'Downtown')"),
  z.object({
    lat: z.number().describe("Latitude coordinate"),
    lon: z.number().describe("Longitude coordinate"),
    address: z.string().optional().describe("Optional human-readable address")
  }).describe("A coordinate object with lat/lon and optional address")
]);

export const MobilityRequestSchema = z.object({
  service: z.enum(["uber", "tesla", "lyft"]).describe("The mobility service to use."),
  pickup_location: UnifiedLocationSchema.describe("The starting point for the ride (string address or coordinate object with lat/lon)."),
  destination_location: UnifiedLocationSchema.optional().describe("The destination for the ride (string address or coordinate object with lat/lon)."),
  dropoff_location: UnifiedLocationSchema.optional().describe("Alias for destination_location. Use this if the LLM provides dropoff_location instead of destination_location."),
  ride_type: z.string().optional().describe("The type of ride (e.g., 'UberX', 'Model S').")
});

export const RouteEstimateSchema = z.object({
  origin: UnifiedLocationSchema.describe("The starting location (string address or coordinate object with lat/lon)."),
  destination: UnifiedLocationSchema.describe("The destination location (string address or coordinate object with lat/lon)."),
  travel_mode: z.enum(["driving", "walking", "bicycling", "transit"]).default("driving").describe("The mode of travel.")
});
