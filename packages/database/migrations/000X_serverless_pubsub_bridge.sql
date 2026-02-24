-- ============================================================================
-- SERVERLESS PUB/SUB BRIDGE MIGRATION
-- Postgres Trigger to QStash HTTP
-- ============================================================================
-- 
-- Problem Solved: LISTEN/NOTIFY in Serverless Environments
-- - Traditional LISTEN/NOTIFY requires persistent PostgreSQL connections
-- - Vercel serverless functions are short-lived (10s timeout on Hobby tier)
-- - Cannot maintain persistent LISTEN connections
--
-- Solution: Postgres Trigger + http_request Extension
-- - Uses PostgreSQL trigger to fire HTTP call on INSERT to outbox table
-- - Converts database event directly into QStash execution trigger
-- - No persistent listener or cron-job delay required
--
-- Architecture:
-- 1. Enable http extension (available in Neon/Supabase)
-- 2. Create function that calls http_post() to QStash
-- 3. Create trigger on outbox table (AFTER INSERT)
-- 4. Trigger sends HTTP POST to QStash webhook
-- 5. QStash reliably delivers to /api/engine/outbox-relay endpoint
--
-- Benefits:
-- - Zero-latency notification (fires immediately on commit)
-- - No polling overhead or consistency lag
-- - Reliable delivery via QStash retries
-- - Serverless-native (no persistent workers needed)
--
-- Usage:
-- 1. Set QSTASH_TOKEN environment variable
-- 2. Run this migration
-- 3. Outbox events will automatically trigger QStash delivery
--
-- Rollback:
--   DROP TRIGGER IF EXISTS outbox_http_notify ON outbox;
--   DROP FUNCTION IF EXISTS notify_outbox_via_http();
-- ============================================================================

-- Step 1: Enable http extension (if not already enabled)
-- Note: Requires superuser or appropriate permissions
-- On Neon/Supabase, this extension is typically pre-installed
CREATE EXTENSION IF NOT EXISTS http;

-- Step 2: Create function to send HTTP request via http extension
-- This function is called by the trigger on every INSERT to outbox
CREATE OR REPLACE FUNCTION notify_outbox_via_http()
RETURNS trigger AS $$
DECLARE
  -- QStash configuration
  -- qstash_url: QStash topic endpoint for outbox events
  -- qstash_token: Authentication token (set via current_setting)
  qstash_url TEXT := 'https://qstash.upstash.io/v2/topics/outbox_events';
  qstash_token TEXT := current_setting('app.qstash_token', TRUE);
  payload_json TEXT;
  http_response RECORD;
BEGIN
  -- Build JSON payload for QStash
  -- Includes outbox event metadata for processing
  payload_json := json_build_object(
    'outboxId', NEW.id,
    'executionId', (NEW.payload->>'executionId'),
    'eventType', NEW.eventType,
    'timestamp', NOW()
  )::text;

  -- Send HTTP POST to QStash
  -- Uses http_post from http extension
  -- Includes authentication and content-type headers
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

  -- Log result if status code indicates failure
  -- Note: Success (200-299) is silently accepted
  IF http_response.status_code IS DISTINCT FROM 200 THEN
    RAISE WARNING 'QStash notification failed for outbox %: status=%, content=%',
      NEW.id,
      http_response.status_code,
      http_response.content;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Grant execute permission to appropriate roles
-- Adjust role name based on your database configuration
GRANT EXECUTE ON FUNCTION notify_outbox_via_http() TO postgres;

-- Step 3: Create trigger on outbox table
-- Fires AFTER INSERT for each row
-- Calls notify_outbox_via_http() function
DROP TRIGGER IF EXISTS outbox_http_notify ON outbox;
CREATE TRIGGER outbox_http_notify
  AFTER INSERT ON outbox
  FOR EACH ROW
  EXECUTE FUNCTION notify_outbox_via_http();

-- Step 4: Create index for efficient outbox event lookup
-- Improves performance of fallback polling mechanism
CREATE INDEX IF NOT EXISTS outbox_status_pending_idx
  ON outbox (status, created_at)
  WHERE status = 'pending';

-- Step 5: Set up QStash token configuration
-- This setting is used by the PL/pgSQL function
-- In production, set via application or migration script:
-- SELECT set_config('app.qstash_token', 'your_qstash_token_here', FALSE);

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Check if http extension is installed
-- SELECT EXISTS (
--   SELECT 1 FROM pg_extension WHERE extname = 'http'
-- ) as http_extension_installed;

-- Check if trigger exists
-- SELECT EXISTS (
--   SELECT 1 FROM pg_trigger WHERE tgname = 'outbox_http_notify'
-- ) as trigger_installed;

-- Check if function exists
-- SELECT EXISTS (
--   SELECT 1 FROM pg_proc WHERE proname = 'notify_outbox_via_http'
-- ) as function_installed;

-- Test the trigger (uncomment to test)
-- INSERT INTO outbox (id, event_type, payload, status, created_at)
-- VALUES (
--   gen_random_uuid(),
--   'TEST_EVENT',
--   '{"executionId": "test-123", "timestamp": "2024-01-01T00:00:00Z"}'::jsonb,
--   'pending',
--   NOW()
-- );

-- ============================================================================
-- ROLLBACK INSTRUCTIONS
-- ============================================================================
-- To rollback this migration:
--
-- 1. Drop the trigger:
--    DROP TRIGGER IF EXISTS outbox_http_notify ON outbox;
--
-- 2. Drop the function:
--    DROP FUNCTION IF EXISTS notify_outbox_via_http();
--
-- 3. (Optional) Drop the index:
--    DROP INDEX IF EXISTS outbox_status_pending_idx;
--
-- 4. (Optional) Disable http extension:
--    DROP EXTENSION IF EXISTS http;
-- ============================================================================
