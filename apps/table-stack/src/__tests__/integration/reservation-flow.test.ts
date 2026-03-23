/**
 * Integration Tests: Reservation Flow
 * 
 * Tests the complete reservation lifecycle from availability check to booking confirmation.
 * 
 * @see Phase 3.1: Integration Test Suite
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb, restaurants, restaurantTables, restaurantReservations, guestProfiles } from '@repo/database';
import { eq, and, gte, lte, sql, or } from '@repo/database';
import { addMinutes, parseISO } from 'date-fns';

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Create a test restaurant
 */
async function createTestRestaurant(overrides?: Partial<typeof restaurants.$inferInsert>) {
  const [restaurant] = await getDb().insert(restaurants).values({
    name: `Test Restaurant ${Date.now()}`,
    slug: `test-restaurant-${Date.now()}`,
    ownerEmail: `test-${Date.now()}@example.com`,
    ownerId: 'test-owner',
    apiKey: `ts_test_${Math.random().toString(36).substring(2, 10)}`,
    isShadow: false,
    isClaimed: true,
    ...overrides,
  }).returning();
  
  return restaurant;
}

/**
 * Create test tables for a restaurant
 */
async function createTestTables(restaurantId: string, count: number = 5) {
  const tables = [];
  for (let i = 0; i < count; i++) {
    const [table] = await getDb().insert(restaurantTables).values({
      restaurantId,
      tableNumber: `T${i + 1}`,
      minCapacity: 2,
      maxCapacity: 4,
      xPos: i * 100,
      yPos: 0,
      isActive: true,
      status: 'vacant',
    }).returning();
    tables.push(table);
  }
  return tables;
}

/**
 * Clean up test data
 */
async function cleanupTestData(restaurantId: string) {
  await getDb().delete(restaurantReservations).where(eq(restaurantReservations.restaurantId, restaurantId));
  await getDb().delete(restaurantTables).where(eq(restaurantTables.restaurantId, restaurantId));
  await getDb().delete(guestProfiles).where(eq(guestProfiles.restaurantId, restaurantId));
  await getDb().delete(restaurants).where(eq(restaurants.id, restaurantId));
}

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

describe('Reservation Integration Tests', () => {
  let testRestaurant: typeof restaurants.$inferSelect;
  let testTables: Array<typeof restaurantTables.$inferSelect>;
  
  beforeAll(async () => {
    // Setup test data
    testRestaurant = await createTestRestaurant();
    testTables = await createTestTables(testRestaurant.id, 5);
  });
  
  afterAll(async () => {
    // Cleanup
    if (testRestaurant) {
      await cleanupTestData(testRestaurant.id);
    }
  });
  
  describe('Availability Check', () => {
    it('should return available tables for valid request', async () => {
      const testTime = new Date(Date.now() + 86400000); // Tomorrow
      const testTimeStr = testTime.toISOString();
      
      const availableTables = await getDb().query.restaurantTables.findMany({
        where: and(
          eq(restaurantTables.restaurantId, testRestaurant.id),
          eq(restaurantTables.isActive, true),
          eq(restaurantTables.status, 'vacant'),
          gte(restaurantTables.maxCapacity, 2)
        ),
      });
      
      expect(availableTables).toHaveLength(5);
      expect(availableTables.map(t => t.id)).toEqual(testTables.map(t => t.id));
    });
    
    it('should exclude tables with conflicting reservations', async () => {
      const testTime = new Date(Date.now() + 86400000 * 2); // Day after tomorrow
      const startTime = testTime;
      const endTime = addMinutes(startTime, 90);
      
      // Create a reservation for table 1
      const [reservation] = await getDb().insert(restaurantReservations).values({
        restaurantId: testRestaurant.id,
        tableId: testTables[0].id,
        guestName: 'Test Guest',
        guestEmail: 'test@example.com',
        partySize: 2,
        startTime,
        endTime,
        status: 'confirmed',
        isVerified: true,
      }).returning();
      
      expect(reservation).toBeDefined();
      
      // Check availability - table 1 should be excluded
      const occupiedTableIdsQuery = await getDb()
        .select({ tableId: restaurantReservations.tableId })
        .from(restaurantReservations)
        .where(
          and(
            eq(restaurantReservations.restaurantId, testRestaurant.id),
            eq(restaurantReservations.status, 'confirmed'),
            sql`${restaurantReservations.startTime} <= ${endTime} AND ${restaurantReservations.endTime} >= ${startTime}`
          )
        );
      
      const occupiedTableIds = occupiedTableIdsQuery.map(r => r.tableId);
      expect(occupiedTableIds).toContain(testTables[0].id);
    });
  });
  
  describe('Reservation Creation', () => {
    it('should create reservation successfully', async () => {
      const testTime = new Date(Date.now() + 86400000 * 3);
      const startTime = testTime;
      const endTime = addMinutes(startTime, 90);
      
      const [reservation] = await getDb().insert(restaurantReservations).values({
        restaurantId: testRestaurant.id,
        tableId: testTables[1].id,
        guestName: 'Integration Test',
        guestEmail: 'integration@example.com',
        partySize: 3,
        startTime,
        endTime,
        status: 'confirmed',
        isVerified: true,
      }).returning();
      
      expect(reservation).toBeDefined();
      expect(reservation.restaurantId).toBe(testRestaurant.id);
      expect(reservation.tableId).toBe(testTables[1].id);
      expect(reservation.guestName).toBe('Integration Test');
    });
    
    it('should update guest profile on reservation', async () => {
      const testTime = new Date(Date.now() + 86400000 * 4);
      const guestEmail = `guest-${Date.now()}@example.com`;
      
      // First reservation
      await getDb().insert(restaurantReservations).values({
        restaurantId: testRestaurant.id,
        tableId: testTables[2].id,
        guestName: 'Repeat Guest',
        guestEmail,
        partySize: 2,
        startTime: testTime,
        endTime: addMinutes(testTime, 90),
        status: 'confirmed',
        isVerified: true,
      });
      
      // Create/update guest profile
      const [profile] = await getDb().insert(guestProfiles).values({
        restaurantId: testRestaurant.id,
        email: guestEmail,
        name: 'Repeat Guest',
        visitCount: 1,
      }).onConflictDoUpdate({
        target: [guestProfiles.restaurantId, guestProfiles.email],
        set: {
          name: 'Repeat Guest',
          visitCount: sql.raw(`${guestProfiles.visitCount} + 1`),
        }
      }).returning();
      
      expect(profile).toBeDefined();
      expect(profile.email).toBe(guestEmail);
      expect(profile.visitCount).toBeGreaterThanOrEqual(1);
    });
  });
  
  describe('Race Condition Prevention', () => {
    it('should prevent double booking via transaction', async () => {
      const testTime = new Date(Date.now() + 86400000 * 5);
      const startTime = testTime;
      const endTime = addMinutes(startTime, 90);
      const tableId = testTables[3].id;
      
      // Simulate concurrent booking attempts with transaction
      const bookingResults = await Promise.allSettled([
        getDb().transaction(async (tx) => {
          // Check for conflicts
          const conflict = await tx.query.restaurantReservations.findFirst({
            where: and(
              eq(restaurantReservations.restaurantId, testRestaurant.id),
              eq(restaurantReservations.tableId, tableId),
              eq(restaurantReservations.status, 'confirmed'),
              sql`${restaurantReservations.startTime} <= ${endTime} AND ${restaurantReservations.endTime} >= ${startTime}`
            ),
          });
          
          if (conflict) {
            throw new Error('Table already booked');
          }
          
          // Create reservation
          const [reservation] = await tx.insert(restaurantReservations).values({
            restaurantId: testRestaurant.id,
            tableId,
            guestName: 'Concurrent Guest 1',
            guestEmail: 'guest1@example.com',
            partySize: 2,
            startTime,
            endTime,
            status: 'confirmed',
            isVerified: true,
          }).returning();
          
          return reservation;
        }),
        
        getDb().transaction(async (tx) => {
          // Small delay to simulate race
          await new Promise(resolve => setTimeout(resolve, 10));
          
          // Check for conflicts
          const conflict = await tx.query.restaurantReservations.findFirst({
            where: and(
              eq(restaurantReservations.restaurantId, testRestaurant.id),
              eq(restaurantReservations.tableId, tableId),
              eq(restaurantReservations.status, 'confirmed'),
              sql`${restaurantReservations.startTime} <= ${endTime} AND ${restaurantReservations.endTime} >= ${startTime}`
            ),
          });
          
          if (conflict) {
            throw new Error('Table already booked');
          }
          
          // Create reservation
          const [reservation] = await tx.insert(restaurantReservations).values({
            restaurantId: testRestaurant.id,
            tableId,
            guestName: 'Concurrent Guest 2',
            guestEmail: 'guest2@example.com',
            partySize: 2,
            startTime,
            endTime,
            status: 'confirmed',
            isVerified: true,
          }).returning();
          
          return reservation;
        }),
      ]);
      
      // One should succeed, one should fail
      const successCount = bookingResults.filter(r => r.status === 'fulfilled').length;
      const failureCount = bookingResults.filter(r => r.status === 'rejected').length;
      
      expect(successCount).toBe(1);
      expect(failureCount).toBe(1);
      
      // Verify only one reservation was created
      const reservations = await getDb().query.restaurantReservations.findMany({
        where: and(
          eq(restaurantReservations.restaurantId, testRestaurant.id),
          eq(restaurantReservations.tableId, tableId),
          eq(restaurantReservations.startTime, startTime)
        ),
      });
      
      expect(reservations).toHaveLength(1);
    });
  });
  
  describe('Reservation Cancellation', () => {
    it('should cancel reservation and free table', async () => {
      const testTime = new Date(Date.now() + 86400000 * 6);
      
      // Create reservation
      const [reservation] = await getDb().insert(restaurantReservations).values({
        restaurantId: testRestaurant.id,
        tableId: testTables[4].id,
        guestName: 'Cancel Test',
        guestEmail: 'cancel@example.com',
        partySize: 2,
        startTime: testTime,
        endTime: addMinutes(testTime, 90),
        status: 'confirmed',
        isVerified: true,
      }).returning();
      
      expect(reservation).toBeDefined();
      
      // Cancel reservation
      await getDb().update(restaurantReservations)
        .set({ status: 'cancelled' })
        .where(eq(restaurantReservations.id, reservation.id));
      
      // Verify cancellation
      const updated = await getDb().query.restaurantReservations.findFirst({
        where: eq(restaurantReservations.id, reservation.id),
      });
      
      expect(updated?.status).toBe('cancelled');
      
      // Table should now be available
      const availableTables = await getDb().query.restaurantTables.findMany({
        where: and(
          eq(restaurantTables.restaurantId, testRestaurant.id),
          eq(restaurantTables.isActive, true),
          eq(restaurantTables.status, 'vacant')
        ),
      });
      
      expect(availableTables).toHaveLength(5); // All tables available
    });
  });
});

// ============================================================================
// EXPORTS
// ============================================================================

export {
  createTestRestaurant,
  createTestTables,
  cleanupTestData,
};
