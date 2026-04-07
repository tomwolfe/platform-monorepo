/**
 * Apply Serverless Outbox Table Migration
 *
 * This script creates the outbox table and polling index.
 * Serverless outbox processing uses application-layer QStash triggers
 * via OutboxRelayService — no Postgres extensions or triggers required.
 */

import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

async function applyMigration() {
  const sql = neon(DATABASE_URL);

  console.log('🔧 Applying Serverless Outbox Table migration...\n');

  try {
    // Step 0: Check if outbox table exists, create if not
    console.log('📦 Step 0: Checking for outbox table...');
    const outboxCheck = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'outbox'
      ) as exists
    `;
    const outboxExists = (outboxCheck[0] as any).exists;

    if (!outboxExists) {
      console.log('⚠️  outbox table not found. Creating it now...');

      // Create enum first
      await sql`
        DO $$ BEGIN
          CREATE TYPE outbox_status AS ENUM ('pending', 'processing', 'processed', 'failed');
        EXCEPTION
          WHEN duplicate_object THEN null;
        END $$;
      `;

      // Create outbox table
      await sql`
        CREATE TABLE IF NOT EXISTS outbox (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          event_type text NOT NULL,
          payload jsonb NOT NULL,
          status outbox_status DEFAULT 'pending' NOT NULL,
          attempts integer DEFAULT 0 NOT NULL,
          error_message text,
          created_at timestamp DEFAULT now() NOT NULL,
          processed_at timestamp,
          expires_at timestamp
        )
      `;

      console.log('✅ outbox table created\n');
    } else {
      console.log('✅ outbox table exists\n');
    }

    // Step 1: Create polling index (always useful for fallback)
    console.log('📦 Step 1: Creating index for efficient polling...');
    await sql`
      CREATE INDEX IF NOT EXISTS outbox_status_pending_idx
        ON outbox (status, created_at)
        WHERE status = 'pending'
    `;

    console.log('✅ Index created\n');

    // Step 2: Verify installation
    console.log('📦 Step 2: Verifying installation...\n');

    const indexExists = await sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'outbox_status_pending_idx'
      ) as exists
    `;

    console.log('   Outbox Table: ✅ Exists');
    console.log('   Polling Index:', (indexExists[0] as any).exists ? '✅ Installed' : '❌ Not Installed');

    console.log('\n✅ Serverless Outbox Table setup complete!\n');
    console.log('📝 Note: Outbox processing uses application-layer QStash triggers');
    console.log('   - OutboxRelayService.triggerRelay() is called after DB commit');
    console.log('   - QStash delivers to /api/engine/outbox-relay endpoint');
    console.log('   - No Postgres extensions or triggers required (Neon compatible)\n');
    console.log('📝 Next steps:');
    console.log('   1. Set QSTASH_TOKEN and INTERNAL_SYSTEM_KEY environment variables');
    console.log('   2. Ensure OutboxRelayService is initialized at app startup\n');

  } catch (error: unknown) {
    console.error('❌ Migration failed:', error instanceof Error ? error.message : String(error));
    if ((error as any).detail) {
      console.error('   Detail:', (error as any).detail);
    }
    if ((error as any).hint) {
      console.error('   Hint:', (error as any).hint);
    }
    process.exit(1);
  }
}

applyMigration();
