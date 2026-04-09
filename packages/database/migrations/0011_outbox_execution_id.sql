-- ============================================================================
-- OUTBOX EXECUTION_ID COLUMN MIGRATION
-- Adds top-level execution_id column to outbox and outbox_dlq tables
-- ============================================================================
--
-- Problem Solved: O(N) Full Table Scans on JSONB Queries
-- - getEventsByExecutionId queried: payload->>'executionId' = $1
-- - Without a GIN index or dedicated column, this triggered full table scans
-- - As the outbox grows, this severely degrades Postgres performance
--
-- Solution: Extract execution_id to a top-level UUID column with B-Tree index
-- - B-Tree index on execution_id provides O(log N) lookups
-- - Backfill: Populates execution_id from existing JSONB payload data
--
-- Usage:
-- 1. Run this migration to add execution_id columns and indexes
-- 2. Application code (outbox.ts) is updated to write execution_id on insert
-- 3. getEventsByExecutionId uses eq(outbox.executionId, id) instead of JSONB
--
-- Rollback:
--   ALTER TABLE outbox DROP COLUMN IF EXISTS execution_id;
--   ALTER TABLE outbox_dlq DROP COLUMN IF EXISTS execution_id;
-- ============================================================================

-- Step 1: Add execution_id column to outbox table
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS execution_id uuid;

-- Step 2: Backfill execution_id from JSONB payload for existing records
-- This extracts the executionId from the JSONB payload into the new column
UPDATE outbox
SET execution_id = (payload->>'executionId')::uuid
WHERE execution_id IS NULL
  AND payload->>'executionId' IS NOT NULL
  AND payload->>'executionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Step 3: Create B-Tree index on execution_id for efficient lookups
-- Drop the old JSONB expression index if it exists
DROP INDEX IF EXISTS outbox_execution_id_idx;
CREATE INDEX IF NOT EXISTS outbox_execution_id_idx ON outbox USING btree (execution_id);

-- Step 4: Add execution_id column to outbox_dlq table
ALTER TABLE outbox_dlq ADD COLUMN IF NOT EXISTS execution_id uuid;

-- Step 5: Backfill execution_id in DLQ from JSONB payload
UPDATE outbox_dlq
SET execution_id = (payload->>'executionId')::uuid
WHERE execution_id IS NULL
  AND payload->>'executionId' IS NOT NULL
  AND payload->>'executionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Step 6: Create B-Tree index on execution_id for DLQ lookups
DROP INDEX IF EXISTS outbox_dlq_execution_id_idx;
CREATE INDEX IF NOT EXISTS outbox_dlq_execution_id_idx ON outbox_dlq USING btree (execution_id);

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Check if execution_id column exists on outbox
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'outbox' AND column_name = 'execution_id';

-- Check if index exists on outbox
-- SELECT indexname FROM pg_indexes WHERE tablename = 'outbox' AND indexname = 'outbox_execution_id_idx';

-- ============================================================================
-- ROLLBACK INSTRUCTIONS
-- ============================================================================
-- To rollback this migration:
--
-- 1. Drop the indexes:
--    DROP INDEX IF EXISTS outbox_execution_id_idx;
--    DROP INDEX IF EXISTS outbox_dlq_execution_id_idx;
--
-- 2. Drop the columns:
--    ALTER TABLE outbox DROP COLUMN IF EXISTS execution_id;
--    ALTER TABLE outbox_dlq DROP COLUMN IF EXISTS execution_id;
-- ============================================================================
