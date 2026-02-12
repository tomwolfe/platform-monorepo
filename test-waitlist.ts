import 'dotenv/config';
import { db } from './src/db';
import { waitlist, restaurants } from './src/db/schema';
import { eq } from 'drizzle-orm';
import Ably from 'ably';

async function testWaitlist() {
  console.log('🧪 Testing Waitlist Module...');

  // 1. Get a restaurant (using the demo one from seed)
  const restaurant = await db.query.restaurants.findFirst({
    where: eq(restaurants.slug, 'demo'),
  });

  if (!restaurant) {
    console.error('❌ Demo restaurant not found. Please run npm run db:seed first.');
    process.exit(1);
  }

  console.log(`📍 Using restaurant: ${restaurant.name} (ID: ${restaurant.id})`);

  // 2. Mock a waitlist entry
  console.log('📝 Creating a mock waitlist entry...');
  const [entry] = await db.insert(waitlist).values({
    restaurantId: restaurant.id,
    guestName: 'Test Guest',
    guestEmail: 'test@example.com',
    partySize: 4,
    status: 'waiting',
  }).returning();

  console.log(`✅ Entry created with ID: ${entry.id}`);

  // 3. Test status update to 'notified'
  console.log('🔔 Updating status to "notified"...');
  const [updatedEntry] = await db.update(waitlist)
    .set({ status: 'notified', updatedAt: new Date() })
    .where(eq(waitlist.id, entry.id))
    .returning();

  console.log(`✅ Status updated to: ${updatedEntry.status}`);

  // 4. Verify Ably Broadcast (Manual check if ABLY_API_KEY is present)
  if (process.env.ABLY_API_KEY) {
    console.log('📡 Testing Ably broadcast...');
    try {
      const ably = new Ably.Rest(process.env.ABLY_API_KEY);
      const channel = ably.channels.get(`restaurant:${restaurant.id}`);
      await channel.publish('waitlist-updated', {
        id: updatedEntry.id,
        status: updatedEntry.status,
      });
      console.log('✅ Ably broadcast successful');
    } catch (error) {
      console.error('❌ Ably broadcast failed:', error);
    }
  } else {
    console.warn('⚠️ ABLY_API_KEY missing, skipping Ably broadcast test');
  }

  // 5. Cleanup
  console.log('🧹 Cleaning up test entry...');
  await db.delete(waitlist).where(eq(waitlist.id, entry.id));
  console.log('✅ Cleanup complete');

  console.log('🚀 Waitlist Module test complete!');
}

testWaitlist().catch(console.error);
