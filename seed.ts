import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { restaurants, restaurantTables } from './src/db/schema';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

const sql = neon(databaseUrl);
const db = drizzle(sql);

async function seed() {
  console.log('🌱 Seeding demo restaurant...');

  const [restaurant] = await db.insert(restaurants).values({
    name: 'The Pesto Place',
    slug: 'demo',
    ownerEmail: 'owner@pestoplace.com',
    ownerId: 'user_2abc123', // Demo Clerk ID
    apiKey: 'pk_test_123456789',
  }).returning();

  console.log(`✅ Created restaurant: ${restaurant.name} (ID: ${restaurant.id})`);

  const tables = [
    { tableNumber: '1', minCapacity: 2, maxCapacity: 2, xPos: 100, yPos: 100, tableType: 'square' },
    { tableNumber: '2', minCapacity: 2, maxCapacity: 2, xPos: 250, yPos: 100, tableType: 'square' },
    { tableNumber: '3', minCapacity: 4, maxCapacity: 4, xPos: 100, yPos: 250, tableType: 'square' },
    { tableNumber: '4', minCapacity: 4, maxCapacity: 6, xPos: 250, yPos: 250, tableType: 'round' },
    { tableNumber: '5', minCapacity: 2, maxCapacity: 2, xPos: 400, yPos: 100, tableType: 'booth' },
  ];

  for (const table of tables) {
    await db.insert(restaurantTables).values({
      ...table,
      restaurantId: restaurant.id,
    });
  }

  console.log(`✅ Created ${tables.length} tables`);
  console.log('🚀 Seed complete!');
}

seed().catch(console.error);
