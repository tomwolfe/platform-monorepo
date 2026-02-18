import 'dotenv/config';
import { db, restaurants, restaurantTables, users, restaurantReservations, restaurantWaitlist } from "@repo/database";
import { eq } from 'drizzle-orm';

/**
 * Enhanced Seed Script
 * 
 * Creates:
 * - Demo restaurant with tables
 * - Diverse user profiles with interaction contexts
 * - Sample reservations and waitlist entries
 * - Failed booking scenarios for testing failover policies
 */

async function seed() {
  console.log('🌱 Seeding demo data with diverse interaction contexts...\n');

  // ==========================================================================
  // RESTAURANTS
  // ==========================================================================
  
  console.log('🍽️  Creating restaurants...');
  
  const [restaurant] = await db.insert(restaurants).values({
    name: 'The Pesto Place',
    slug: 'demo',
    ownerEmail: 'owner@pestoplace.com',
    ownerId: 'user_2abc123',
    apiKey: 'pk_test_123456789',
    lat: '37.7749',
    lng: '-122.4194',
    address: '123 Market St, San Francisco, CA 94103',
  }).onConflictDoUpdate({
    target: restaurants.slug,
    set: {
      name: 'The Pesto Place',
      ownerEmail: 'owner@pestoplace.com',
      ownerId: 'user_2abc123',
      apiKey: 'pk_test_123456789',
    }
  }).returning();

  console.log(`   ✅ ${restaurant.name} (ID: ${restaurant.id})`);

  // Create a second restaurant for alternative suggestions
  const [restaurant2] = await db.insert(restaurants).values({
    name: 'Bella Italia',
    slug: 'bella-italia',
    ownerEmail: 'owner@bellaitalia.com',
    ownerId: 'user_3def456',
    apiKey: 'pk_test_987654321',
    lat: '37.7751',
    lng: '-122.4180',
    address: '456 Mission St, San Francisco, CA 94105',
  }).onConflictDoUpdate({
    target: restaurants.slug,
    set: {
      name: 'Bella Italia',
    }
  }).returning();

  console.log(`   ✅ ${restaurant2.name} (ID: ${restaurant2.id})`);

  // ==========================================================================
  // RESTAURANT TABLES
  // ==========================================================================
  
  console.log('\n🪑  Creating tables...');

  await db.delete(restaurantTables).where(eq(restaurantTables.restaurantId, restaurant.id));

  const tables = [
    { tableNumber: '1', minCapacity: 2, maxCapacity: 2, xPos: 100, yPos: 100, tableType: 'square', status: 'available' },
    { tableNumber: '2', minCapacity: 2, maxCapacity: 2, xPos: 250, yPos: 100, tableType: 'square', status: 'occupied' },
    { tableNumber: '3', minCapacity: 4, maxCapacity: 4, xPos: 100, yPos: 250, tableType: 'square', status: 'available' },
    { tableNumber: '4', minCapacity: 6, maxCapacity: 8, xPos: 250, yPos: 250, tableType: 'round', status: 'available' },
    { tableNumber: '5', minCapacity: 2, maxCapacity: 2, xPos: 400, yPos: 100, tableType: 'booth', status: 'occupied' },
  ];

  for (const table of tables) {
    await db.insert(restaurantTables).values({
      ...table,
      restaurantId: restaurant.id,
    });
  }

  console.log(`   ✅ Created ${tables.length} tables at ${restaurant.name}`);

  // ==========================================================================
  // USERS WITH DIVERSE INTERACTION CONTEXTS
  // ==========================================================================
  
  console.log('\n👥  Creating users with diverse interaction contexts...');

  const usersData = [
    {
      clerkId: 'user_test_001',
      email: 'alice@example.com',
      name: 'Alice Chen',
      lastInteractionContext: {
        intentType: 'BOOKING',
        rawText: 'Book a table for 2 at Pesto Place tonight at 7pm',
        parameters: {
          restaurantId: restaurant.id,
          restaurantSlug: 'demo',
          restaurantName: 'The Pesto Place',
          partySize: 2,
          time: '19:00',
          date: new Date().toISOString().split('T')[0],
        },
        timestamp: new Date(Date.now() - 1000 * 60 * 30).toISOString(), // 30 min ago
        executionId: 'exec_alice_001',
      },
    },
    {
      clerkId: 'user_test_002',
      email: 'bob@example.com',
      name: 'Bob Martinez',
      lastInteractionContext: {
        intentType: 'DELIVERY',
        rawText: 'Order delivery from Bella Italia to my office',
        parameters: {
          restaurantId: restaurant2.id,
          restaurantSlug: 'bella-italia',
          restaurantName: 'Bella Italia',
          deliveryAddress: '456 Mission St, San Francisco, CA 94105',
          items: ['Margherita Pizza', 'Caesar Salad'],
        },
        timestamp: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(), // 2 hours ago
        executionId: 'exec_bob_001',
        outcome: 'success',
      },
    },
    {
      clerkId: 'user_test_003',
      email: 'carol@example.com',
      name: 'Carol Williams',
      lastInteractionContext: {
        intentType: 'BOOKING',
        rawText: 'Can I get a table for 8 this Friday at 8pm?',
        parameters: {
          restaurantId: restaurant.id,
          restaurantSlug: 'demo',
          restaurantName: 'The Pesto Place',
          partySize: 8,
          time: '20:00',
          date: new Date(Date.now() + 1000 * 60 * 60 * 24 * 2).toISOString().split('T')[0], // 2 days from now
        },
        timestamp: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(), // 5 hours ago
        executionId: 'exec_carol_001',
        outcome: 'failed',
        failureReason: 'PARTY_SIZE_TOO_LARGE',
      },
    },
    {
      clerkId: 'user_test_004',
      email: 'david@example.com',
      name: 'David Kim',
      lastInteractionContext: {
        intentType: 'WAITLIST',
        rawText: 'Add me to the waitlist for Pesto Place',
        parameters: {
          restaurantId: restaurant.id,
          restaurantSlug: 'demo',
          restaurantName: 'The Pesto Place',
          partySize: 4,
        },
        timestamp: new Date(Date.now() - 1000 * 60 * 15).toISOString(), // 15 min ago
        executionId: 'exec_david_001',
        outcome: 'success',
      },
    },
    {
      clerkId: 'user_test_005',
      email: 'emma@example.com',
      name: 'Emma Thompson',
      lastInteractionContext: {
        intentType: 'BOOKING',
        rawText: 'Book a table for 2 at 7:30pm',
        parameters: {
          restaurantId: restaurant.id,
          restaurantSlug: 'demo',
          restaurantName: 'The Pesto Place',
          partySize: 2,
          time: '19:30',
          date: new Date().toISOString().split('T')[0],
        },
        timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(), // 1 day ago
        executionId: 'exec_emma_001',
        outcome: 'failed',
        failureReason: 'RESTAURANT_FULL',
      },
    },
    {
      clerkId: 'user_test_006',
      email: 'frank@example.com',
      name: 'Frank Rodriguez',
      lastInteractionContext: {
        intentType: 'RESERVATION_MODIFY',
        rawText: 'Change my reservation from 7pm to 8pm',
        parameters: {
          restaurantId: restaurant.id,
          restaurantSlug: 'demo',
          restaurantName: 'The Pesto Place',
          reservationId: 'res_frank_001',
          newTime: '20:00',
        },
        timestamp: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(), // 3 hours ago
        executionId: 'exec_frank_001',
        outcome: 'success',
      },
    },
  ];

  for (const userData of usersData) {
    await db.insert(users).values(userData).onConflictDoUpdate({
      target: users.clerkId,
      set: {
        name: userData.name,
        lastInteractionContext: userData.lastInteractionContext as any,
      },
    });
    console.log(`   ✅ ${userData.name} - Last intent: ${userData.lastInteractionContext.intentType}`);
  }

  // ==========================================================================
  // SAMPLE RESERVATIONS
  // ==========================================================================
  
  console.log('\n📅  Creating sample reservations...');

  const reservations = [
    {
      restaurantId: restaurant.id,
      tableId: tables[1].id, // Table 2
      guestName: 'Bob Martinez',
      guestEmail: 'bob@example.com',
      partySize: 2,
      startTime: new Date(Date.now() + 1000 * 60 * 60), // 1 hour from now
      endTime: new Date(Date.now() + 1000 * 60 * 60 * 2.5),
      status: 'confirmed',
      isVerified: true,
    },
    {
      restaurantId: restaurant.id,
      tableId: tables[4].id, // Table 5
      guestName: 'David Kim',
      guestEmail: 'david@example.com',
      partySize: 2,
      startTime: new Date(Date.now() + 1000 * 60 * 60 * 1.5), // 1.5 hours from now
      endTime: new Date(Date.now() + 1000 * 60 * 60 * 3),
      status: 'confirmed',
      isVerified: true,
    },
  ];

  for (const reservation of reservations) {
    await db.insert(restaurantReservations).values(reservation);
    console.log(`   ✅ Reservation for ${reservation.guestName} at ${reservation.startTime.toLocaleTimeString()}`);
  }

  // ==========================================================================
  // WAITLIST ENTRIES
  // ==========================================================================
  
  console.log('\n⏳  Creating waitlist entries...');

  const waitlistEntries = [
    {
      restaurantId: restaurant.id,
      guestName: 'Carol Williams',
      guestEmail: 'carol@example.com',
      partySize: 4,
      status: 'waiting',
    },
    {
      restaurantId: restaurant.id,
      guestName: 'Emma Thompson',
      guestEmail: 'emma@example.com',
      partySize: 2,
      status: 'waiting',
    },
  ];

  for (const entry of waitlistEntries) {
    await db.insert(restaurantWaitlist).values(entry);
    console.log(`   ✅ Waitlist: ${entry.guestName} (party of ${entry.partySize})`);
  }

  // ==========================================================================
  // SUMMARY
  // ==========================================================================
  
  console.log('\n📊 Seed Summary:');
  console.log(`   - Restaurants: 2`);
  console.log(`   - Tables: ${tables.length}`);
  console.log(`   - Users: ${usersData.length}`);
  console.log(`   - Reservations: ${reservations.length}`);
  console.log(`   - Waitlist entries: ${waitlistEntries.length}`);
  
  console.log('\n🎯 Test Scenarios Enabled:');
  console.log('   - ✅ Pre-flight state injection (restaurant availability)');
  console.log('   - ✅ Failover policies (full restaurant → alternatives)');
  console.log('   - ✅ Semantic memory (diverse user interaction contexts)');
  console.log('   - ✅ Schema evolution (failed bookings with mismatched parameters)');
  
  console.log('\n🚀 Seed complete! Ready for testing.\n');
}

seed().catch(console.error);
