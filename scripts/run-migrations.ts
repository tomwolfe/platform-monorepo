/**
 * Direct SQL migration script for OpenDeliver tables
 * Run with: pnpm tsx scripts/run-migrations.ts
 */

import { neon } from '@neondatabase/serverless';

async function runMigrations() {
  const databaseUrl = process.env.DATABASE_URL;
  
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL environment variable is not set');
    process.exit(1);
  }

  console.log('🚀 Running OpenDeliver migrations...');
  
  const sql = neon(databaseUrl);

  try {
    // Create drivers table
    await sql.query(`
      CREATE TABLE IF NOT EXISTS drivers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        clerk_id TEXT UNIQUE,
        full_name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        trust_score INTEGER DEFAULT 80,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        last_online TIMESTAMP WITH TIME ZONE
      )
    `, []);
    console.log('✅ Created drivers table');

    // Create indexes for drivers
    await sql.query(`CREATE UNIQUE INDEX IF NOT EXISTS drivers_clerk_id_idx ON drivers(clerk_id)`, []);
    await sql.query(`CREATE UNIQUE INDEX IF NOT EXISTS drivers_email_idx ON drivers(email)`, []);
    console.log('✅ Created drivers indexes');

    // Create orders table (base table if not exists)
    await sql.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID,
        driver_id UUID,
        store_id UUID,
        status TEXT NOT NULL DEFAULT 'pending',
        total DOUBLE PRECISION NOT NULL DEFAULT 0,
        delivery_address TEXT NOT NULL,
        pickup_address TEXT,
        special_instructions TEXT,
        priority TEXT DEFAULT 'standard',
        matched_at TIMESTAMP WITH TIME ZONE,
        picked_up_at TIMESTAMP WITH TIME ZONE,
        delivered_at TIMESTAMP WITH TIME ZONE,
        cancelled_at TIMESTAMP WITH TIME ZONE,
        cancellation_reason TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `, []);
    console.log('✅ Created orders table');

    // Add missing columns if they don't exist
    const columnsToAdd = [
      { column: 'driver_id', type: 'UUID' },
      { column: 'pickup_address', type: 'TEXT' },
      { column: 'special_instructions', type: 'TEXT' },
      { column: 'priority', type: 'TEXT' },
      { column: 'matched_at', type: 'TIMESTAMP WITH TIME ZONE' },
      { column: 'picked_up_at', type: 'TIMESTAMP WITH TIME ZONE' },
      { column: 'delivered_at', type: 'TIMESTAMP WITH TIME ZONE' },
      { column: 'cancelled_at', type: 'TIMESTAMP WITH TIME ZONE' },
      { column: 'cancellation_reason', type: 'TEXT' },
    ];

    for (const { column, type } of columnsToAdd) {
      try {
        await sql.query(`
          ALTER TABLE orders 
          ADD COLUMN IF NOT EXISTS ${column} ${type}
        `, []);
        console.log(`✅ Added column ${column} to orders`);
      } catch (e: any) {
        console.log(`ℹ️  Column ${column} handling:`, e.message);
      }
    }

    // Add foreign key constraints if they don't exist
    try {
      await sql.query(`
        ALTER TABLE orders 
        ADD CONSTRAINT orders_user_id_fkey 
        FOREIGN KEY (user_id) REFERENCES users(id)
      `, []);
      console.log('✅ Added user_id foreign key');
    } catch (e: any) {
      if (!e.message?.includes('already exists')) {
        console.log('ℹ️  user_id foreign key may already exist');
      }
    }

    try {
      await sql.query(`
        ALTER TABLE orders 
        ADD CONSTRAINT orders_driver_id_fkey 
        FOREIGN KEY (driver_id) REFERENCES drivers(id)
      `, []);
      console.log('✅ Added driver_id foreign key');
    } catch (e: any) {
      if (!e.message?.includes('already exists')) {
        console.log('ℹ️  driver_id foreign key may already exist');
      }
    }

    try {
      await sql.query(`
        ALTER TABLE orders 
        ADD CONSTRAINT orders_store_id_fkey 
        FOREIGN KEY (store_id) REFERENCES restaurants(id)
      `, []);
      console.log('✅ Added store_id foreign key');
    } catch (e: any) {
      if (!e.message?.includes('already exists')) {
        console.log('ℹ️  store_id foreign key may already exist');
      }
    }

    // Create indexes for orders
    await sql.query(`CREATE INDEX IF NOT EXISTS orders_user_id_idx ON orders(user_id)`, []);
    await sql.query(`CREATE INDEX IF NOT EXISTS orders_driver_id_idx ON orders(driver_id)`, []);
    await sql.query(`CREATE INDEX IF NOT EXISTS orders_store_id_idx ON orders(store_id)`, []);
    await sql.query(`CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status)`, []);
    console.log('✅ Created orders indexes');

    // Create order_items table
    await sql.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID NOT NULL,
        name TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        price DOUBLE PRECISION NOT NULL,
        special_instructions TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `, []);
    console.log('✅ Created order_items table');

    // Add foreign key for order_items
    try {
      await sql.query(`
        ALTER TABLE order_items 
        ADD CONSTRAINT order_items_order_id_fkey 
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      `, []);
      console.log('✅ Added order_id foreign key');
    } catch (e: any) {
      if (!e.message?.includes('already exists')) {
        console.log('ℹ️  order_id foreign key may already exist');
      }
    }

    // Create index for order_items
    await sql.query(`CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON order_items(order_id)`, []);
    console.log('✅ Created order_items indexes');

    console.log('\n✅ All migrations completed successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  }
}

runMigrations()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
