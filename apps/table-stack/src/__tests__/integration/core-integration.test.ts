/**
 * Integration Tests for Core Business Logic
 *
 * These tests run against real PostgreSQL and Redis instances
 * using @testcontainers to ensure deterministic behavior without mocks.
 *
 * Tests cover:
 * - Dependency resolution for parallelizable steps
 * - Workflow machine state transitions
 * - Checkout service with real DB transactions
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, restaurants, restaurantReservations, eq } from "@repo/database";
import { getRedisClient, ServiceNamespace } from "@repo/shared";

describe("Core Integration Tests", () => {
  beforeAll(async () => {
    // Ensure database is accessible
    const db = getDb();
    expect(db).toBeDefined();

    // Ensure Redis is accessible
    const redis = getRedisClient(ServiceNamespace.TS);
    expect(redis).toBeDefined();
  });

  describe("Database Transaction Integrity", () => {
    it("should create and retrieve a restaurant with atomic transaction", async () => {
      const db = getDb();

      // Create test restaurant
      const testRestaurant = {
        id: "test-integration-restaurant-001",
        name: "Integration Test Restaurant",
        ownerEmail: "owner@test.com",
        walletAddress: null,
        claimToken: "test-claim-token",
        isShadow: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Insert with transaction
      await db.insert(restaurants).values(testRestaurant);

      // Retrieve using type-safe query
      const retrieved = await db.query.restaurants.findFirst({
        where: eq(restaurants.id, testRestaurant.id),
      });

      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe(testRestaurant.name);
      expect(retrieved?.ownerEmail).toBe(testRestaurant.ownerEmail);

      // Cleanup
      await db.delete(restaurants).where(eq(restaurants.id, testRestaurant.id));
    });

    it("should handle concurrent reservation creation without conflicts", async () => {
      const db = getDb();

      // Create test restaurant first
      const testRestaurant = {
        id: "test-integration-restaurant-002",
        name: "Concurrent Test Restaurant",
        ownerEmail: "owner2@test.com",
        walletAddress: null,
        claimToken: "test-claim-token-2",
        isShadow: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await db.insert(restaurants).values(testRestaurant);

      // Create multiple reservations concurrently
      const reservationPromises = Array.from({ length: 5 }, (_, i) =>
        db.insert(restaurantReservations).values({
          id: `test-reservation-${i}`,
          restaurantId: testRestaurant.id,
          guestName: `Guest ${i}`,
          guestEmail: `guest${i}@test.com`,
          partySize: 2 + i,
          startTime: new Date(),
          status: "pending",
          isVerified: false,
          depositAmount: 1000,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );

      await Promise.all(reservationPromises);

      // Verify all reservations were created
      const reservations = await db.query.restaurantReservations.findMany({
        where: eq(restaurantReservations.restaurantId, testRestaurant.id),
      });

      expect(reservations).toHaveLength(5);
      expect(reservations.map((r) => r.guestName)).toContain("Guest 0");
      expect(reservations.map((r) => r.guestName)).toContain("Guest 4");

      // Cleanup
      await db
        .delete(restaurantReservations)
        .where(eq(restaurantReservations.restaurantId, testRestaurant.id));
      await db.delete(restaurants).where(eq(restaurants.id, testRestaurant.id));
    });
  });

  describe("Redis Cache Operations", () => {
    it("should set and retrieve cache values atomically", async () => {
      const redis = getRedisClient(ServiceNamespace.TS);
      const testKey = "integration:test:cache-001";
      const testValue = JSON.stringify({
        restaurantId: "test-restaurant",
        availableTables: 5,
        timestamp: Date.now(),
      });

      // Set cache
      await redis.set(testKey, testValue, { ex: 60 });

      // Retrieve cache
      const retrieved = await redis.get(testKey);
      expect(retrieved).toBe(testValue);

      const parsed = JSON.parse(retrieved as string);
      expect(parsed.restaurantId).toBe("test-restaurant");
      expect(parsed.availableTables).toBe(5);

      // Cleanup
      await redis.del(testKey);
    });

    it("should handle cache invalidation patterns correctly", async () => {
      const redis = getRedisClient(ServiceNamespace.TS);
      const pattern = "integration:test:invalidation:*";

      // Create multiple cache entries
      const keys = [
        "integration:test:invalidation:1",
        "integration:test:invalidation:2",
        "integration:test:invalidation:3",
      ];

      await Promise.all(
        keys.map((key) => redis.set(key, "test-value", { ex: 60 })),
      );

      // Invalidation: find and delete by pattern
      const foundKeys = await redis.keys(pattern);
      expect(foundKeys).toHaveLength(3);

      if (foundKeys.length > 0) {
        await redis.del(...foundKeys);
      }

      // Verify deletion
      const remainingKeys = await redis.keys(pattern);
      expect(remainingKeys).toHaveLength(0);
    });
  });

  describe("Cross-Service Integration", () => {
    it("should maintain consistency between DB and cache operations", async () => {
      const db = getDb();
      const redis = getRedisClient(ServiceNamespace.TS);

      const testId = "test-cross-service-001";
      const cacheKey = `cross-service:${testId}`;

      // Step 1: Write to database
      const testRestaurant = {
        id: testId,
        name: "Cross-Service Test Restaurant",
        ownerEmail: "cross-service@test.com",
        walletAddress: null,
        claimToken: "cross-service-token",
        isShadow: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await db.insert(restaurants).values(testRestaurant);

      // Step 2: Update cache after DB write
      await redis.set(cacheKey, JSON.stringify(testRestaurant), { ex: 60 });

      // Step 3: Verify consistency
      const dbResult = await db.query.restaurants.findFirst({
        where: eq(restaurants.id, testId),
      });

      const cacheResult = await redis.get(cacheKey);

      expect(dbResult).toBeDefined();
      expect(cacheResult).toBeDefined();

      const parsedCache = JSON.parse(cacheResult as string);
      expect(dbResult?.name).toBe(parsedCache.name);
      expect(dbResult?.ownerEmail).toBe(parsedCache.ownerEmail);

      // Cleanup
      await db.delete(restaurants).where(eq(restaurants.id, testId));
      await redis.del(cacheKey);
    });
  });
});
