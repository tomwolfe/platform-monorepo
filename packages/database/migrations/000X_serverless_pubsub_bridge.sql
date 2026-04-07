-- ============================================================================
-- SERVERLESS OUTBOX TABLE MIGRATION
-- Application-Layer QStash Triggers (OutboxRelayService)
-- ============================================================================
--
-- Problem Solved: LISTEN/NOTIFY in Serverless Environments
-- - Traditional LISTEN/NOTIFY requires persistent PostgreSQL connections
-- - Vercel serverless functions are short-lived (10s timeout on Hobby tier)
-- - Cannot maintain persistent LISTEN connections
--
-- Solution: Application-Layer QStash Triggers via OutboxRelayService
-- - After DB transaction commits in API route, fire-and-forget QStash trigger
-- - QStash provides near-instant state sync (like persistent worker) with serverless cost model
-- - No Postgres extensions required (Neon Serverless compatible)
--
-- Architecture:
-- 1. API route commits transaction with outbox event
-- 2. API route calls OutboxRelayService.triggerRelay(executionId) after commit
-- 3. QStash delivers POST to /api/engine/outbox-relay endpoint
-- 4. Outbox relay processes pending events and updates Redis cache
--
-- NOTE: Serverless outbox relies on application-layer QStash triggers
-- (OutboxRelayService), bypassing Postgres pg_notify/http extensions.
-- The previous version of this migration attempted to use the PostgreSQL
-- http extension with an AFTER INSERT trigger (notify_outbox_via_http),
-- but the http extension is incompatible with Neon Serverless.
--
-- Usage:
-- 1. Run this migration to create the outbox table and index
-- 2. Set QSTASH_TOKEN and INTERNAL_SYSTEM_KEY environment variables
-- 3. OutboxRelayService handles triggering automatically after transactions
--
-- Rollback:
--   DROP TABLE IF EXISTS outbox;
--   DROP INDEX IF EXISTS outbox_status_pending_idx;
-- ============================================================================

-- Step 1: Create outbox_status enum type
DO $$ BEGIN
  CREATE TYPE outbox_status AS ENUM ('pending', 'processing', 'processed', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Step 2: Create outbox table
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
);

-- Step 3: Create index for efficient polling (used by OutboxRelayService fallback)
CREATE INDEX IF NOT EXISTS outbox_status_pending_idx
  ON outbox (status, created_at)
  WHERE status = 'pending';

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Check if outbox table exists
-- SELECT EXISTS (
--   SELECT 1 FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'outbox'
-- ) as outbox_exists;

-- Check if polling index exists
-- SELECT EXISTS (
--   SELECT 1 FROM pg_indexes
--   WHERE indexname = 'outbox_status_pending_idx'
-- ) as index_exists;

-- ============================================================================
-- ROLLBACK INSTRUCTIONS
-- ============================================================================
-- To rollback this migration:
--
-- 1. Drop the index:
--    DROP INDEX IF EXISTS outbox_status_pending_idx;
--
-- 2. Drop the table:
--    DROP TABLE IF EXISTS outbox;
--
-- 3. Drop the enum type:
--    DROP TYPE IF EXISTS outbox_status;
-- ============================================================================
