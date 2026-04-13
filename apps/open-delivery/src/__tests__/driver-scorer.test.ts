/**
 * Driver Scorer Unit Tests
 *
 * Tests for pure functions in driver-scorer.ts
 * These tests require NO mocking of DB, Redis, or external services
 * because all functions are side-effect-free.
 *
 * Coverage Goal: 100%
 */

import { describe, it, expect } from "vitest";
import {
  getRequiredVehicleType,
  calculateTotalWeight,
  determineVehicleTypeFromWeight,
  calculateDriverScore,
  calculateTrustScoreComponent,
  calculateVehicleCompatibility,
  calculateAcceptanceRateComponent,
  calculateProximityScore,
  calculateHaversineDistance,
  toRadians,
  calculateBoundingBox,
  scoreAndRankDrivers,
  type Driver,
  type OrderItem,
} from "@open-delivery/lib/driver-scorer";

// ============================================================================
// TEST FIXTURES
// ============================================================================

const createDriver = (overrides: Partial<Driver> = {}): Driver => ({
  id: "driver-1",
  clerkId: "clerk-1",
  fullName: "John Doe",
  email: "john@example.com",
  trustScore: 80,
  isActive: true,
  vehicleType: "car",
  currentLat: 40.7128,
  currentLng: -74.006,
  acceptedOrders: 100,
  completedOrders: 90,
  ...overrides,
});

const createOrderItem = (overrides: Partial<OrderItem> = {}): OrderItem => ({
  name: "Package",
  quantity: 1,
  weight: 5,
  ...overrides,
});

// ============================================================================
// WEIGHT CALCULATION TESTS
// ============================================================================

describe("calculateTotalWeight", () => {
  it("should calculate total weight with explicit weights", () => {
    const items = [
      createOrderItem({ weight: 10 }),
      createOrderItem({ weight: 15 }),
      createOrderItem({ weight: 20 }),
    ];
    expect(calculateTotalWeight(items)).toBe(45);
  });

  it("should use default weight when not specified", () => {
    const items = [
      createOrderItem({ weight: undefined }),
      createOrderItem({ weight: undefined }),
    ];
    expect(calculateTotalWeight(items)).toBe(1.0); // 0.5 * 2
  });

  it("should allow custom default weight", () => {
    const items = [createOrderItem({ weight: undefined })];
    expect(calculateTotalWeight(items, 2.0)).toBe(2.0);
  });

  it("should return 0 for empty array", () => {
    expect(calculateTotalWeight([])).toBe(0);
  });
});

describe("determineVehicleTypeFromWeight", () => {
  it("should return bike for weight <= 5kg", () => {
    expect(determineVehicleTypeFromWeight(0)).toBe("bike");
    expect(determineVehicleTypeFromWeight(5)).toBe("bike");
  });

  it("should return car for weight 5-20kg", () => {
    expect(determineVehicleTypeFromWeight(5.1)).toBe("car");
    expect(determineVehicleTypeFromWeight(20)).toBe("car");
  });

  it("should return van for weight 20-50kg", () => {
    expect(determineVehicleTypeFromWeight(20.1)).toBe("van");
    expect(determineVehicleTypeFromWeight(50)).toBe("van");
  });

  it("should return truck for weight > 50kg", () => {
    expect(determineVehicleTypeFromWeight(50.1)).toBe("truck");
    expect(determineVehicleTypeFromWeight(100)).toBe("truck");
  });
});

describe("getRequiredVehicleType", () => {
  it("should determine bike for light items", () => {
    const items = [
      createOrderItem({ weight: 2 }),
      createOrderItem({ weight: 3 }),
    ];
    expect(getRequiredVehicleType(items)).toBe("bike");
  });

  it("should determine car for medium items", () => {
    const items = [
      createOrderItem({ weight: 10 }),
      createOrderItem({ weight: 8 }),
    ];
    expect(getRequiredVehicleType(items)).toBe("car");
  });

  it("should determine van for weight 20-50kg", () => {
    const items = [
      createOrderItem({ weight: 25 }),
      createOrderItem({ weight: 20 }),
    ]; // 45kg total
    expect(getRequiredVehicleType(items)).toBe("van");
  });

  it("should determine truck for very heavy items", () => {
    const items = [
      createOrderItem({ weight: 60 }),
      createOrderItem({ weight: 70 }),
    ];
    expect(getRequiredVehicleType(items)).toBe("truck");
  });

  it("should use default weight when item weight is undefined", () => {
    const items = [
      createOrderItem({ weight: undefined }),
      createOrderItem({ weight: undefined }),
      createOrderItem({ weight: undefined }),
      createOrderItem({ weight: undefined }),
      createOrderItem({ weight: undefined }),
      createOrderItem({ weight: undefined }),
      createOrderItem({ weight: undefined }),
      createOrderItem({ weight: undefined }),
      createOrderItem({ weight: undefined }),
      createOrderItem({ weight: undefined }),
      createOrderItem({ weight: undefined }),
    ]; // 11 * 0.5 = 5.5kg
    expect(getRequiredVehicleType(items)).toBe("car");
  });
});

// ============================================================================
// DRIVER SCORING TESTS
// ============================================================================

describe("calculateTrustScoreComponent", () => {
  it("should calculate 40% of trust score", () => {
    expect(calculateTrustScoreComponent(100)).toBe(40);
    expect(calculateTrustScoreComponent(80)).toBe(32);
    expect(calculateTrustScoreComponent(50)).toBe(20);
    expect(calculateTrustScoreComponent(0)).toBe(0);
  });
});

describe("calculateVehicleCompatibility", () => {
  it("should give max score for perfect match", () => {
    expect(calculateVehicleCompatibility("bike", "bike")).toBe(25);
    expect(calculateVehicleCompatibility("car", "car")).toBe(25);
    expect(calculateVehicleCompatibility("van", "van")).toBe(25);
    expect(calculateVehicleCompatibility("truck", "truck")).toBe(25);
  });

  it("should give 15 points for valid upgrades", () => {
    // Bike order can be fulfilled by car or van
    expect(calculateVehicleCompatibility("car", "bike")).toBe(15);
    expect(calculateVehicleCompatibility("van", "bike")).toBe(15);
    // Car order can be fulfilled by van
    expect(calculateVehicleCompatibility("van", "car")).toBe(15);
  });

  it("should give 0 for incompatible vehicles", () => {
    expect(calculateVehicleCompatibility("bike", "car")).toBe(0);
    expect(calculateVehicleCompatibility("bike", "van")).toBe(0);
    expect(calculateVehicleCompatibility("bike", "truck")).toBe(0);
    expect(calculateVehicleCompatibility("car", "van")).toBe(0);
    expect(calculateVehicleCompatibility("car", "truck")).toBe(0);
  });

  it("should handle undefined vehicle type", () => {
    expect(calculateVehicleCompatibility(undefined, "car")).toBe(0);
  });
});

describe("calculateAcceptanceRateComponent", () => {
  it("should calculate based on completion rate", () => {
    expect(calculateAcceptanceRateComponent(100, 90)).toBeCloseTo(22.5); // 90/100 * 25
    expect(calculateAcceptanceRateComponent(100, 100)).toBe(25);
    expect(calculateAcceptanceRateComponent(100, 50)).toBe(12.5);
  });

  it("should return 0 when no data available", () => {
    expect(calculateAcceptanceRateComponent(undefined, 90)).toBe(0);
    expect(calculateAcceptanceRateComponent(100, undefined)).toBe(0);
    expect(calculateAcceptanceRateComponent(0, 0)).toBe(0);
  });
});

describe("calculateProximityScore", () => {
  it("should give max score for very close drivers (< 1km)", () => {
    // Same location
    expect(calculateProximityScore(40.7128, -74.006, 40.7128, -74.006)).toBe(
      10,
    );
  });

  it("should decrease score with distance", () => {
    // ~1km away
    const score1 = calculateProximityScore(40.7128, -74.006, 40.7218, -74.006);
    // ~2km away
    const score2 = calculateProximityScore(40.7128, -74.006, 40.7308, -74.006);

    expect(score1).toBeGreaterThan(score2);
  });

  it("should return 0 for very far drivers (> 5km)", () => {
    // ~10km away
    const score = calculateProximityScore(40.7128, -74.006, 40.8028, -74.006);
    expect(score).toBe(0);
  });
});

describe("calculateHaversineDistance", () => {
  it("should return 0 for same coordinates", () => {
    expect(calculateHaversineDistance(40.7128, -74.006, 40.7128, -74.006)).toBe(
      0,
    );
  });

  it("should calculate approximate NYC to LA distance", () => {
    const distance = calculateHaversineDistance(
      40.7128, // NYC
      -74.006,
      34.0522, // LA
      -118.2437,
    );
    // Actual distance is ~3940km, allow 5% margin
    expect(distance).toBeGreaterThan(3700);
    expect(distance).toBeLessThan(4200);
  });

  it("should calculate approximate London to Paris distance", () => {
    const distance = calculateHaversineDistance(
      51.5074, // London
      -0.1278,
      48.8566, // Paris
      2.3522,
    );
    // Actual distance is ~344km, allow 5% margin
    expect(distance).toBeGreaterThan(320);
    expect(distance).toBeLessThan(370);
  });
});

describe("toRadians", () => {
  it("should convert degrees to radians", () => {
    expect(toRadians(0)).toBe(0);
    expect(toRadians(180)).toBeCloseTo(Math.PI);
    expect(toRadians(360)).toBeCloseTo(Math.PI * 2);
    expect(toRadians(90)).toBeCloseTo(Math.PI / 2);
  });
});

describe("calculateDriverScore", () => {
  it("should calculate comprehensive driver score", () => {
    const driver = createDriver({
      trustScore: 80,
      vehicleType: "car",
      acceptedOrders: 100,
      completedOrders: 90,
      currentLat: 40.7128,
      currentLng: -74.006,
    });

    const score = calculateDriverScore(driver, "car", 40.7128, -74.006);

    // Trust: 80 * 0.4 = 32
    // Vehicle: 25 (perfect match)
    // Acceptance: 90/100 * 25 = 22.5
    // Proximity: 10 (same location)
    // Total: 32 + 25 + 22.5 + 10 = 89.5
    expect(score).toBeCloseTo(89.5, 1);
  });

  it("should score lower for incompatible vehicle", () => {
    const driver = createDriver({
      vehicleType: "bike",
      trustScore: 80,
    });

    const score = calculateDriverScore(driver, "truck", 40.7128, -74.006);

    // Trust: 32
    // Vehicle: 0 (incompatible)
    // Acceptance: 22.5
    // Proximity: 10
    // Total: 64.5
    expect(score).toBeCloseTo(64.5, 1);
  });

  it("should handle driver without location", () => {
    const driver = createDriver({
      currentLat: undefined,
      currentLng: undefined,
    });

    const score = calculateDriverScore(driver, "car", 40.7128, -74.006);

    // No proximity points
    expect(score).toBeLessThan(80);
  });
});

// ============================================================================
// BOUNDING BOX TESTS
// ============================================================================

describe("calculateBoundingBox", () => {
  it("should calculate bounding box around center point", () => {
    const bbox = calculateBoundingBox(40.7128, -74.006, 50);

    expect(bbox.minLat).toBeLessThan(40.7128);
    expect(bbox.maxLat).toBeGreaterThan(40.7128);
    expect(bbox.minLng).toBeLessThan(-74.006);
    expect(bbox.maxLng).toBeGreaterThan(-74.006);
  });

  it("should clamp coordinates to valid ranges", () => {
    // Near North Pole
    const northBbox = calculateBoundingBox(89.9, 0, 200);
    expect(northBbox.maxLat).toBeLessThanOrEqual(90);

    // Near South Pole
    const southBbox = calculateBoundingBox(-89.9, 0, 200);
    expect(southBbox.minLat).toBeGreaterThanOrEqual(-90);
  });

  it("should handle different radii", () => {
    const smallBbox = calculateBoundingBox(40.7128, -74.006, 10);
    const largeBbox = calculateBoundingBox(40.7128, -74.006, 100);

    // Larger radius should produce larger bounding box
    expect(largeBbox.maxLat - largeBbox.minLat).toBeGreaterThan(
      smallBbox.maxLat - smallBbox.minLat,
    );
  });

  it("should use default 50km radius", () => {
    const bbox = calculateBoundingBox(40.7128, -74.006);
    expect(bbox).toBeDefined();
  });
});

// ============================================================================
// DRIVER RANKING TESTS
// ============================================================================

describe("scoreAndRankDrivers", () => {
  it("should rank drivers by score descending", () => {
    const drivers = [
      createDriver({ id: "driver-1", trustScore: 60 }),
      createDriver({ id: "driver-2", trustScore: 90 }),
      createDriver({ id: "driver-3", trustScore: 75 }),
    ];

    const ranked = scoreAndRankDrivers(drivers, "car", 40.7128, -74.006);

    expect(ranked[0].driver.id).toBe("driver-2");
    expect(ranked[1].driver.id).toBe("driver-3");
    expect(ranked[2].driver.id).toBe("driver-1");
  });

  it("should include match scores in results", () => {
    const drivers = [
      createDriver({ id: "driver-1", trustScore: 80 }),
      createDriver({ id: "driver-2", trustScore: 70 }),
    ];

    const ranked = scoreAndRankDrivers(drivers, "car", 40.7128, -74.006);

    expect(ranked[0].matchScore).toBeGreaterThan(0);
    expect(ranked[1].matchScore).toBeGreaterThan(0);
    expect(ranked[0].matchScore).toBeGreaterThan(ranked[1].matchScore);
  });

  it("should handle empty driver array", () => {
    const ranked = scoreAndRankDrivers([], "car", 40.7128, -74.006);
    expect(ranked).toEqual([]);
  });

  it("should handle single driver", () => {
    const drivers = [createDriver()];
    const ranked = scoreAndRankDrivers(drivers, "car", 40.7128, -74.006);
    expect(ranked).toHaveLength(1);
  });
});
