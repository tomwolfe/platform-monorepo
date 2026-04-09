-- ============================================================================
-- FIX OUTBOX POLLING INDEX
-- Covers both 'pending' and 'processing' statuses for DLQ recovery sweeps
-- ============================================================================
--
-- Problem:
-- - The existing index outbox_status_pending_idx only covers status = 'pending'
-- - The background sweeper/DLQ recovery queries for BOTH 'pending' AND 'processing'
-- - This causes Postgres to ignore the partial index during recovery sweeps,
--   leading to sequence scans as the outbox grows
--
-- Solution:
-- - Drop the old partial index (WHERE status = 'pending')
-- - Create a new partial index covering both 'pending' and 'processing' statuses
--
-- Rollback:
--   DROP INDEX IF EXISTS outbox_status_polling_idx;
--   CREATE INDEX IF NOT EXISTS outbox_status_pending_idx ON outbox (status, created_at) WHERE status = 'pending';
-- ============================================================================

-- Step 1: Drop the old partial index
DROP INDEX IF EXISTS outbox_status_pending_idx;

-- Step 2: Create new partial index covering both pending and processing
CREATE INDEX IF NOT EXISTS outbox_status_polling_idx
  ON outbox (status, created_at)
  WHERE status IN ('pending', 'processing');

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Check if new index exists
-- SELECT indexname, indexdef FROM pg_indexes WHERE indexname = 'outbox_status_polling_idx';

-- Check old index is gone
-- SELECT indexname FROM pg_indexes WHERE indexname = 'outbox_status_pending_idx';

-- ============================================================================
-- ROLLBACK INSTRUCTIONS
-- ============================================================================
-- To rollback this migration:
--
-- 1. Drop the new index:
--    DROP INDEX IF EXISTS outbox_status_polling_idx;
--
-- 2. Recreate the old index:
--    CREATE INDEX IF NOT EXISTS outbox_status_pending_idx
--      ON outbox (status, created_at)
--      WHERE status = 'pending';
-- ============================================================================
