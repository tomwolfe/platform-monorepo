/**
 * Apply Serverless Pub/Sub Bridge Migration
 * 
 * This script applies the PostgreSQL trigger migration for the Serverless Pub/Sub Bridge.
 * The trigger automatically sends HTTP requests to QStash when outbox events are inserted.
 */

import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

async function applyMigration() {
  const sql = neon(DATABASE_URL);

  console.log('🔧 Applying Serverless Pub/Sub Bridge migration...\n');

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

    // Step 1: Check if http extension is available
    console.log('📦 Step 1: Checking for http extension...');
    const httpExtensionCheck = await sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'http'
      ) as installed
    `;
    const httpAvailable = (httpExtensionCheck[0] as any).installed;
    
    if (!httpAvailable) {
      console.log('⚠️  http extension not available (Neon does not support it)');
      console.log('✅ Falling back to polling-based outbox processing\n');
      console.log('📝 The outbox-listener will use fallback polling mode.\n');
    } else {
      console.log('✅ http extension available\n');
      
      // Step 2: Create the function (only if http is available)
      console.log('📦 Step 2: Creating notify_outbox_via_http function...');
      const qstashToken = process.env.QSTASH_TOKEN || process.env.UPSTASH_QSTASH_TOKEN;
      
      if (!qstashToken) {
        console.warn('⚠️  Warning: QSTASH_TOKEN not set. Using placeholder value.\n');
      }

      await sql`
        CREATE OR REPLACE FUNCTION notify_outbox_via_http()
        RETURNS trigger AS $$
        DECLARE
          qstash_url TEXT := 'https://qstash.upstash.io/v2/topics/outbox_events';
          qstash_token TEXT := current_setting('app.qstash_token', TRUE);
          payload_json TEXT;
          http_response RECORD;
        BEGIN
          payload_json := json_build_object(
            'outboxId', NEW.id,
            'executionId', (NEW.payload->>'executionId'),
            'eventType', NEW.eventType,
            'timestamp', NOW()
          )::text;

          SELECT * INTO http_response FROM http_post(
            qstash_url,
            payload_json,
            'application/json',
            ARRAY[
              http_header('Authorization', 'Bearer ' || qstash_token),
              http_header('Content-Type', 'application/json'),
              http_header('x-outbox-bridge', 'true'),
              http_header('x-serverless-bridge', 'postgres-trigger')
            ]
          );

          IF http_response.status_code IS DISTINCT FROM 200 THEN
            RAISE WARNING 'QStash notification failed for outbox %: status=%, content=%',
              NEW.id,
              http_response.status_code,
              http_response.content;
          END IF;

          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `;
      
      console.log('✅ Function created\n');

      // Step 3: Create the trigger
      console.log('📦 Step 3: Creating outbox_http_notify trigger...');
      await sql`DROP TRIGGER IF EXISTS outbox_http_notify ON outbox`;
      
      await sql`
        CREATE TRIGGER outbox_http_notify
          AFTER INSERT ON outbox
          FOR EACH ROW
          EXECUTE FUNCTION notify_outbox_via_http()
      `;
      
      console.log('✅ Trigger created\n');
    }

    // Step 4: Create index for efficient polling (always useful)
    console.log('📦 Step 4: Creating index for efficient polling...');
    await sql`
      CREATE INDEX IF NOT EXISTS outbox_status_created_at_idx
        ON outbox (status, created_at)
        WHERE status = 'pending'
    `;
    
    console.log('✅ Index created\n');

    // Step 5: Verify installation
    console.log('📦 Step 5: Verifying installation...\n');
    
    const triggerExists = await sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'outbox_http_notify'
      ) as exists
    `;
    
    const functionExists = await sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'notify_outbox_via_http'
      ) as exists
    `;
    
    console.log('   Outbox Table: ✅ Exists');
    console.log('   HTTP Extension:', httpAvailable ? '✅ Available' : '❌ Not Available (using fallback polling)');
    console.log('   Trigger:', (triggerExists[0] as any).exists ? '✅ Installed' : 'ℹ️  Not Installed (fallback mode)');
    console.log('   Function:', (functionExists[0] as any).exists ? '✅ Installed' : 'ℹ️  Not Installed (fallback mode)');
    console.log('   Polling Index: ✅ Installed');

    console.log('\n✅ Serverless Pub/Sub Bridge setup complete!\n');
    
    if (!httpAvailable) {
      console.log('📝 Note: Running in fallback polling mode');
      console.log('   - The outbox-listener will poll for pending events every 5 seconds');
      console.log('   - This is the recommended approach for Neon/Serverless environments\n');
    } else {
      console.log('📝 Next steps:');
      console.log('   1. Set your QSTASH_TOKEN environment variable');
      console.log('   2. Test by inserting a record into the outbox table');
      console.log('   3. Check QStash console for message delivery\n');
    }

  } catch (error: any) {
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
