/**
 * Driver Scorer - Pure Functions for Driver Matching
 *
 * Strategy Pattern Implementation:
 * This module contains side-effect-free pure functions for calculating
 * driver scores, determining vehicle requirements, and computing bounding boxes.
 *
 * These functions have NO dependencies on:
 * - Database connections
 * - Redis
 * - External APIs
 * - File system
 *
 * This makes them 100% unit-testable without any mocking.
 *
 * @module DriverScorer
 * @see dispatcher.ts for orchestration (DB/Redis calls)
 */

export interface Driver {
  id: string;
  clerkId: string;
  fullName: string;
  email: string;
  phone?: string;
  trustScore: number;
  isActive: boolean;
  vehicleType?: "bike" | "car" | "van" | "truck";
  currentLat?: number;
  currentLng?: number;
  acceptedOrders?: number;
  completedOrders?: number;
}

export interface OrderItem {
  name: string;
  quantity: number;
  weight?: number;
}

export interface DriverScoreResult {
  driver: Driver;
  matchScore: number;
}

// ============================================================================
// WEIGHT THRESHOLDS (Business Rules)
// ============================================================================

const VEHICLE_WEIGHT_THRESHOLDS = {
  TRUCK: 50, // > 50kg requires truck
  VAN: 20, // > 20kg requires van
  CAR: 5, // > 5kg requires car
  // <= 5kg can use bike
} as const;

// ============================================================================
// SCORING WEIGHTS
// ============================================================================

const SCORING_WEIGHTS = {
  TRUST_SCORE: 0.4, // 40% weight (0-40 points)
  VEHICLE_COMPATIBILITY: 25, // 25 points max
  ACCEPTANCE_RATE: 25, // 25 points max
  PROXIMITY: 10, // 10 points max (closer = higher)
} as const;

// ============================================================================
// VEHICLE UPGRADE PATHS
// A driver with a larger vehicle can fulfill smaller vehicle orders
// ============================================================================

const VEHICLE_UPGRADES: Record<string, string[]> = {
  bike: ["car", "van"], // Bike order can be fulfilled by car/van
  car: ["van"], // Car order can be fulfilled by van
  van: [], // Van order requires van specifically
  truck: [], // Truck order requires truck specifically
} as const;

/**
 * Calculate required vehicle type based on order items
 *
 * Pure function: same input always produces same output
 * No side effects, no I/O
 *
 * @param items - Order items with optional weights
 * @returns Required vehicle type
 *
 * @example
 * ```typescript
 * const items = [{ name: "Package", weight: 25 }];
 * const vehicleType = getRequiredVehicleType(items);
 * // Returns: "van"
 * ```
 */
export function getRequiredVehicleType(
  items: OrderItem[],
): "bike" | "car" | "van" | "truck" {
  const totalWeight = calculateTotalWeight(items);
  return determineVehicleTypeFromWeight(totalWeight);
}

/**
 * Calculate total weight of order items
 *
 * @param items - Order items
 * @param defaultWeight - Default weight per item if not specified (default: 0.5kg)
 * @returns Total weight in kg
 */
export function calculateTotalWeight(
  items: OrderItem[],
  defaultWeight: number = 0.5,
): number {
  return items.reduce((sum, item) => sum + (item.weight || defaultWeight), 0);
}

/**
 * Determine vehicle type from total weight using business rules
 *
 * @param totalWeight - Total weight in kg
 * @returns Required vehicle type
 */
export function determineVehicleTypeFromWeight(
  totalWeight: number,
): "bike" | "car" | "van" | "truck" {
  if (totalWeight > VEHICLE_WEIGHT_THRESHOLDS.TRUCK) return "truck";
  if (totalWeight > VEHICLE_WEIGHT_THRESHOLDS.VAN) return "van";
  if (totalWeight > VEHICLE_WEIGHT_THRESHOLDS.CAR) return "car";
  return "bike";
}

/**
 * Calculate driver score for ranking
 *
 * Higher score = better match
 * Score breakdown:
 * - Trust Score: 0-40 points (40% of 100)
 * - Vehicle Compatibility: 0-25 points
 * - Acceptance Rate: 0-25 points
 * - Proximity: 0-10 points (closer = higher)
 *
 * Pure function: no I/O, deterministic output
 *
 * @param driver - Driver object with location and stats
 * @param requiredVehicle - Required vehicle type for the order
 * @param pickupLat - Pickup location latitude
 * @param pickupLng - Pickup location longitude
 * @returns Driver score (0-100)
 *
 * @example
 * ```typescript
 * const score = calculateDriverScore(
 *   { trustScore: 80, vehicleType: "car", currentLat: 40.7, currentLng: -74.0, ... },
 *   "car",
 *   40.7128,
 *   -74.0060
 * );
 * // Returns: ~85 (depending on distance)
 * ```
 */
export function calculateDriverScore(
  driver: Driver,
  requiredVehicle: string,
  pickupLat: number,
  pickupLng: number,
): number {
  let score = 0;

  // 1. Trust score component (0-40 points)
  score += calculateTrustScoreComponent(driver.trustScore);

  // 2. Vehicle compatibility (0-25 points)
  score += calculateVehicleCompatibility(driver.vehicleType, requiredVehicle);

  // 3. Acceptance rate (0-25 points)
  score += calculateAcceptanceRateComponent(
    driver.acceptedOrders,
    driver.completedOrders,
  );

  // 4. Proximity bonus (0-10 points)
  if (driver.currentLat && driver.currentLng) {
    score += calculateProximityScore(
      driver.currentLat,
      driver.currentLng,
      pickupLat,
      pickupLng,
    );
  }

  return score;
}

/**
 * Calculate trust score component (0-40 points)
 *
 * @param trustScore - Driver's trust score (0-100)
 * @returns Weighted trust score (0-40)
 */
export function calculateTrustScoreComponent(trustScore: number): number {
  return trustScore * SCORING_WEIGHTS.TRUST_SCORE;
}

/**
 * Calculate vehicle compatibility score (0-25 points)
 *
 * Perfect match = 25 points
 * Upgrade (larger vehicle) = 15 points
 * No match = 0 points
 *
 * @param driverVehicle - Driver's vehicle type
 * @param requiredVehicle - Required vehicle type for order
 * @returns Vehicle compatibility score (0-25)
 */
export function calculateVehicleCompatibility(
  driverVehicle: string | undefined,
  requiredVehicle: string,
): number {
  // Perfect match
  if (driverVehicle === requiredVehicle) {
    return SCORING_WEIGHTS.VEHICLE_COMPATIBILITY;
  }

  // Can upgrade to larger vehicle
  const allowedUpgrades = VEHICLE_UPGRADES[requiredVehicle] || [];
  if (allowedUpgrades.includes(driverVehicle || "")) {
    return 15;
  }

  // No compatibility
  return 0;
}

/**
 * Calculate acceptance rate component (0-25 points)
 *
 * @param acceptedOrders - Number of orders accepted
 * @param completedOrders - Number of orders completed
 * @returns Acceptance rate score (0-25)
 */
export function calculateAcceptanceRateComponent(
  acceptedOrders: number | undefined,
  completedOrders: number | undefined,
): number {
  if (!acceptedOrders || !completedOrders || acceptedOrders === 0) {
    return 0; // No data = 0 points
  }

  const acceptanceRate = completedOrders / acceptedOrders;
  return acceptanceRate * SCORING_WEIGHTS.ACCEPTANCE_RATE;
}

/**
 * Calculate proximity score using Haversine distance
 *
 * Closer drivers get higher scores:
 * - < 1km: 10 points (max)
 * - 1-5km: 8-2 points (linear decrease)
 * - > 5km: 0 points
 *
 * @param driverLat - Driver's current latitude
 * @param driverLng - Driver's current longitude
 * @param pickupLat - Pickup location latitude
 * @param pickupLng - Pickup location longitude
 * @returns Proximity score (0-10)
 */
export function calculateProximityScore(
  driverLat: number,
  driverLng: number,
  pickupLat: number,
  pickupLng: number,
): number {
  const distanceKm = calculateHaversineDistance(
    driverLat,
    driverLng,
    pickupLat,
    pickupLng,
  );

  // Linear decrease: 10 points at 0km, 0 points at 5km
  return Math.max(0, SCORING_WEIGHTS.PROXIMITY - distanceKm * 2);
}

/**
 * Calculate Haversine distance between two GPS coordinates
 *
 * The Haversine formula calculates the great-circle distance between
 * two points on a sphere given their longitudes and latitudes.
 *
 * @param lat1 - Latitude of point 1 (degrees)
 * @param lng1 - Longitude of point 1 (degrees)
 * @param lat2 - Latitude of point 2 (degrees)
 * @param lng2 - Longitude of point 2 (degrees)
 * @returns Distance in kilometers
 *
 * @example
 * ```typescript
 * const distance = calculateHaversineDistance(40.7128, -74.0060, 34.0522, -118.2437);
 * // Returns: ~3940 (NYC to LA in km)
 * ```
 */
export function calculateHaversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371; // Earth's radius in km
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Convert degrees to radians
 *
 * @param degrees - Angle in degrees
 * @returns Angle in radians
 */
export function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Calculate bounding box coordinates for proximity search
 *
 * Creates a rectangular bounding box around a center point
 * within the specified search radius.
 *
 * Pure function: deterministic output, no I/O
 *
 * @param centerLat - Center latitude
 * @param centerLng - Center longitude
 * @param radiusKm - Search radius in kilometers
 * @returns Bounding box coordinates { minLat, maxLat, minLng, maxLng }
 *
 * @example
 * ```typescript
 * const bbox = calculateBoundingBox(40.7128, -74.0060, 10);
 * // Returns: { minLat: 40.6228, maxLat: 40.8028, minLng: -74.1260, maxLng: -73.8860 }
 * ```
 */
export function calculateBoundingBox(
  centerLat: number,
  centerLng: number,
  radiusKm: number = 50,
): {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
} {
  // 1 degree of latitude ≈ 111 km
  // 1 degree of longitude ≈ 111 km * cos(lat)
  const latDiff = radiusKm / 111;
  const lngDiff =
    radiusKm / (111 * Math.max(0.01, Math.cos(toRadians(centerLat))));

  // Clamp to valid coordinate ranges
  const minLat = Math.max(-90, centerLat - latDiff);
  const maxLat = Math.min(90, centerLat + latDiff);
  const minLng = Math.max(-180, centerLng - lngDiff);
  const maxLng = Math.min(180, centerLng + lngDiff);

  return { minLat, maxLat, minLng, maxLng };
}

/**
 * Score and rank multiple drivers
 *
 * Pure function: takes array of drivers, returns sorted array with scores
 * No side effects, no I/O
 *
 * @param drivers - Array of drivers to score
 * @param requiredVehicle - Required vehicle type
 * @param pickupLat - Pickup latitude
 * @param pickupLng - Pickup longitude
 * @returns Array of drivers with scores, sorted by score (descending)
 */
export function scoreAndRankDrivers(
  drivers: Driver[],
  requiredVehicle: string,
  pickupLat: number,
  pickupLng: number,
): DriverScoreResult[] {
  const scored = drivers.map((driver) => ({
    driver,
    matchScore: calculateDriverScore(
      driver,
      requiredVehicle,
      pickupLat,
      pickupLng,
    ),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.matchScore - a.matchScore);

  return scored;
}
