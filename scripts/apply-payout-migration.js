#!/usr/bin/env node
/**
 * Apply payout tracking migration manually
 */

const { neon } = require('@neondatabase/serverless');

async function applyMigration() {
  const databaseUrl = process.env.DATABASE_URL;
  
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL environment variable is not set');
    process.exit(1);
  }

  console.log('🔗 Connecting to database...');
  const sql = neon(databaseUrl);

  try {
    console.log('📝 Applying payout tracking migration...');
    
    // Add payout_status column
    await sql`
      ALTER TABLE orders 
      ADD COLUMN IF NOT EXISTS payout_status text DEFAULT 'pending'
    `;
    console.log('✅ Added payout_status column');

    // Add payout_processed_at column
    await sql`
      ALTER TABLE orders 
      ADD COLUMN IF NOT EXISTS payout_processed_at timestamp
    `;
    console.log('✅ Added payout_processed_at column');

    // Create index for efficient querying
    await sql`
      CREATE INDEX IF NOT EXISTS orders_payout_status_idx 
      ON orders USING btree (payout_status)
    `;
    console.log('✅ Created index on payout_status');

    console.log('\n✅ Migration completed successfully!');
    console.log('\n📊 New columns added to orders table:');
    console.log('   - payout_status (text, default: pending)');
    console.log('   - payout_processed_at (timestamp)');
    console.log('\n📌 Index created:');
    console.log('   - orders_payout_status_idx');
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    if (error.detail) {
      console.error('   Detail:', error.detail);
    }
    if (error.hint) {
      console.error('   Hint:', error.hint);
    }
    process.exit(1);
  }
}

applyMigration();
