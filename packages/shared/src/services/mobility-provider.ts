/**
 * Mobility Provider Interface
 *
 * Abstracts mobility/ride-hailing services (Uber, Lyft, Tesla, etc.)
 * behind a common interface for testability and provider swapping.
 *
 * Usage:
 * ```typescript
 * // Define provider interface
 * const provider = new MockMobilityProvider();
 * const result = await provider.requestRide({ ... });
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { z } from "zod";
import { MobilityRequestSchema, UnifiedLocation } from "@repo/mcp-protocol";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Mobility service types
 */
export type MobilityService = "uber" | "lyft" | "tesla" | "waymo";

/**
 * Ride type options
 */
export type RideType = string;

/**
 * Mobility request parameters
 */
export interface MobilityRequest {
  service: MobilityService;
  pickup_location: UnifiedLocation;
  destination_location: UnifiedLocation;
  ride_type?: RideType;
}

/**
 * Mobility request result
 */
export interface MobilityResult {
  status: "requested" | "confirmed" | "cancelled" | "failed";
  service: MobilityService;
  pickup: string;
  destination: string;
  driver_name?: string;
  vehicle_plate?: string;
  estimated_arrival?: string;
  ride_id?: string;
  error?: string;
}

/**
 * Cancellation request parameters
 */
export interface CancellationRequest {
  ride_id?: string;
  service?: MobilityService;
  pickup_location?: string;
  destination_location?: string;
}

/**
 * Cancellation result
 */
export interface CancellationResult {
  status: "cancelled" | "failed";
  ride_id: string;
  cancellation_time: string;
  refund_amount: number;
  message?: string;
  error?: string;
}

// ============================================================================
// PROVIDER INTERFACE
// ============================================================================

/**
 * Mobility provider interface
 * Implement this interface to add new mobility providers
 */
export interface IMobilityProvider {
  /**
   * Request a ride from the provider
   */
  requestRide(params: MobilityRequest): Promise<MobilityResult>;

  /**
   * Cancel an existing ride
   */
  cancelRide(params: CancellationRequest): Promise<CancellationResult>;

  /**
   * Get provider name
   */
  getProviderName(): string;
}

// ============================================================================
// MOCK PROVIDER (For Development/Testing)
// ============================================================================

/**
 * Mock mobility provider for development and testing
 * Generates realistic-looking mock data without calling real APIs
 */
export class MockMobilityProvider implements IMobilityProvider {
  private readonly driverNames = ["Alex", "Jordan", "Sam", "Taylor", "Morgan", "Casey"];
  private readonly vehiclePrefixes = ["ABC", "XYZ", "DEF", "GHI", "JKL", "MNO"];

  getProviderName(): string {
    return "MockMobility";
  }

  /**
   * Generate a random driver name
   */
  private generateDriverName(): string {
    const randomIndex = Math.floor(Math.random() * this.driverNames.length);
    return this.driverNames[randomIndex];
  }

  /**
   * Generate a random vehicle plate
   */
  private generateVehiclePlate(): string {
    const prefix = this.vehiclePrefixes[Math.floor(Math.random() * this.vehiclePrefixes.length)];
    const suffix = Math.random().toString(36).substring(2, 5).toUpperCase();
    return `${prefix}-${suffix}`;
  }

  /**
   * Normalize location to string format
   */
  private normalizeLocation(location: UnifiedLocation | undefined): string {
    if (!location) return "unknown";
    if (typeof location === "string") {
      return location;
    }
    if (location.address) {
      return `${location.address} (${location.lat}, ${location.lon})`;
    }
    return `${location.lat}, ${location.lon}`;
  }

  async requestRide(params: MobilityRequest): Promise<MobilityResult> {
    const { service, pickup_location, destination_location, ride_type } = params;

    const normalizedPickup = this.normalizeLocation(pickup_location);
    const normalizedDestination = this.normalizeLocation(destination_location);

    console.log(`[MockMobility] Ride request: ${service} from ${normalizedPickup} to ${normalizedDestination}`);

    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 100));

    return {
      status: "requested",
      service,
      pickup: normalizedPickup,
      destination: normalizedDestination,
      driver_name: this.generateDriverName(),
      vehicle_plate: this.generateVehiclePlate(),
      estimated_arrival: new Date(Date.now() + 8 * 60 * 1000).toISOString(),
      ride_type,
    };
  }

  async cancelRide(params: CancellationRequest): Promise<CancellationResult> {
    const rideId = params.ride_id || `ride_${Math.random().toString(36).substring(2, 9)}`;

    console.log(`[MockMobility] Cancelling ride: ${rideId}`);

    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 100));

    return {
      status: "cancelled",
      ride_id: rideId,
      cancellation_time: new Date().toISOString(),
      refund_amount: 0, // No charge if cancelled before pickup
      message: "Ride successfully cancelled",
    };
  }
}

// ============================================================================
// PROVIDER FACTORY
// ============================================================================

/**
 * Get mobility provider based on environment
 */
export function getMobilityProvider(service?: MobilityService): IMobilityProvider {
  // In production, throw an error to prevent silent false-positive ride requests
  if (process.env.NODE_ENV === 'production') {
    throw new NotImplementedError(
      'Real mobility providers must be configured. ' +
      'Implement a real provider (Uber, Lyft, etc.) before deploying to production.'
    );
  }

  // In development/testing, return mock provider
  return new MockMobilityProvider();
}

/**
 * Error thrown when a feature is not implemented for production
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

/**
 * Validate mobility request using Zod schema
 */
export function validateMobilityRequest(params: unknown): MobilityRequest {
  return MobilityRequestSchema.parse(params) as MobilityRequest;
}
